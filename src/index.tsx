
/*
The MIT License (MIT)

Copyright (c) 2019 https://github.com/wubostc/

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
*/


import * as React from "react";
import { TableComponents } from "antd/lib/table/interface";


const _brower = 1;
const _node = 2;
const env = typeof window === 'object' && window instanceof Window ? _brower : _node;


if (env & _brower) {
  let f: boolean = Object.hasOwnProperty.call(window, "requestAnimationFrame");
  if (!f) throw new Error("Please using the modern browers or appropriate polyfill!");
}

interface obj extends Object {
  [field: string]: any;
}

interface vt_ctx {
  head: number;
  tail: number;
  fixed: e_fixed;
  [reflection: string]: any;
}

export
interface vt_opts extends Object {
  readonly id: number;
  height?: number; // will use the Table.scroll.y if unset.
  overscanRowCount?: number; // default 5
  reflection?: string[] | string;

  onScroll?: ({ left, top }: { top: number, left: number }) => void;
  destory?: boolean; // default false
  debug?: boolean;
}

/**
 * `INIT` -> `LOADED` -> `RUNNING` <-> `SUSPENDED`
 *  */
enum e_vt_state {
  INIT       = 1,
  LOADED     = 2,
  RUNNING    = 4,
  SUSPENDED  = 8,
}

/**
 * `L`: fixed: "left", `R`: fixed: "right"
 */
enum e_fixed {
  UNKNOW = -1,
  NEITHER,
  L,
  R
}

interface storeValue extends vt_opts {
  components: {
    table: React.ReactType,
    wrapper: React.ReactType,
    row: React.ReactType
  };
  computed_h: number;
  load_the_trs_once: e_vt_state;
  possible_hight_per_tr: number;
  
  /* 0: needn't to recalculate, > 0: to add, < 0 to subtract */
  re_computed: number;
  row_height: number[];
  row_count: number;
  wrap_inst: React.RefObject<HTMLDivElement>;
  context: React.Context<vt_ctx>;

  // return the last state.
  VTScroll?: (param?: { top: number, left: number }) => { top: number, left: number };
  VTRefresh?: () => void;

  _React_ptr: any; // pointer to the instance of `VT`.

  _lstoreval: storeValue; // fixed left.
  _rstoreval: storeValue; // fixed right.


  WH: number;      // Wrapped Height.
                   // it's the newest value of `wrap_inst`'s height to update.

  HND_PAINT: number;      // a handle for Batch Repainting.
  PAINT_ADD: Map<number/* index */, HTMLTableRowElement>;
  PAINT_SADD: Map<number/* shadow index */, number/* height */>;
  PAINT_REPLACE: Map<number/* index */, HTMLTableRowElement>;
  PAINT_FREE: Set<number/* index */>;
}

const store: Map<number, storeValue> = new Map();

/**
 * THE EVENTS OF SCROLLING.
 */
const SCROLLEVT_NULL       = (0<<0);
const SCROLLEVT_INIT       = (1<<0);
const SCROLLEVT_RECOMPUTE  = (1<<1);
const SCROLLEVT_RESTORETO  = (1<<2);
const SCROLLEVT_NATIVE     = (1<<3);
const SCROLLEVT_BARRIER    = (1<<4); // It only for `SCROLLEVT_RECOMPUTE`.
const SCROLLEVT_MASK       = SCROLLEVT_BARRIER | SCROLLEVT_RECOMPUTE;

type SimEvent = { target: { scrollTop: number, scrollLeft: number }, flags: number };

function _make_evt(ne:　Event): SimEvent {
  return {
    target: {
      scrollTop: (ne.target as any).scrollTop,
      scrollLeft: (ne.target as any).scrollLeft,
    },
    flags: SCROLLEVT_NATIVE
  };
}

/**
 * define CONSTANTs.
 */
// const MIN_FRAME = 16;

/**
 * the following functions bind the `values`.
 */
/** update to ColumnProps.fixed synchronously */
function _RC_fixed_setState(val: storeValue, top: number, head: number, tail: number) {
  if (val._lstoreval)
    val._lstoreval._React_ptr.setState({ top, head, tail });
  if (val._rstoreval)
    val._rstoreval._React_ptr.setState({ top, head, tail });
}


function _Update_wrap_style(val: storeValue, h: number) {
  val.wrap_inst.current.style.height = `${h}px`;
  val.wrap_inst.current.style.maxHeight = `${h}px`;
}


/** non-block, just create a macro tack, then only update once. */
function update_wrap_style(val: storeValue, h: number) {
  if (val.WH === h) return;
  val.WH = h;
  _Update_wrap_style(val, h);
  /* update the `ColumnProps.fixed` synchronously */
  if (val._lstoreval) _Update_wrap_style(val._lstoreval, h);
  if (val._rstoreval) _Update_wrap_style(val._rstoreval, h);
}

/**
 * a way that apply a height to `row_height` and `computed_h`.
 */
const WAY_ADD = 0;
const WAY_REPLACE = 1;

type WAY = typeof WAY_ADD | typeof WAY_REPLACE;

/**
 * running level: `LOADED` `RUNNING`.
 */
function apply_h_with(way: WAY, val: storeValue, idx: number, h: number) {
  console.assert(h >= 0);

  let { computed_h, row_height } = val;

  if (val.possible_hight_per_tr === -1) {
    /* assign only once */
    val.possible_hight_per_tr = h;
  }

  if (way === WAY_ADD) {
    if (val.load_the_trs_once === e_vt_state.RUNNING) {
      computed_h += h; // just do add up.
    } else {
      console.assert(val.load_the_trs_once === e_vt_state.LOADED);
      computed_h = h; // reset initial value.
    }
  } else /* WAY_REPLACE */ {
    computed_h = computed_h - row_height[idx] + h;
  }

  row_height[idx] = h;
  val.computed_h = computed_h;
}


function free_h_tr(val: storeValue, idx: number) {
  val.computed_h -= val.row_height[idx];
}


function _repainting(val: storeValue) {
  return requestAnimationFrame(() => {
    const { PAINT_ADD, PAINT_SADD, PAINT_FREE, PAINT_REPLACE } = val;
    
    log_debug(val, "START");

    if (PAINT_FREE.size) {
      for (let idx of val.PAINT_FREE) {
        free_h_tr(val, idx);
      }
      console.assert(val.computed_h >= 0);
      val.PAINT_FREE = new Set();
    }

    if (PAINT_ADD.size) {
      for (let [idx, el] of val.PAINT_ADD) {
        apply_h_with(WAY_ADD, val, idx, el.offsetHeight);
      }
      val.PAINT_ADD = new Map();
    }

    if (PAINT_SADD.size) {
      for (let [idx, h] of PAINT_SADD) {
        apply_h_with(WAY_ADD, val, idx, h);
      }
      val.PAINT_SADD = new Map();
    }

    if (PAINT_REPLACE.size) {
      for (let [idx, el] of val.PAINT_REPLACE) {
        apply_h_with(WAY_REPLACE, val, idx, el.offsetHeight);
      }
      val.PAINT_REPLACE = new Map();
    }

    if (val.computed_h < 0) val.computed_h = 0;
    update_wrap_style(val, val.computed_h);

    // free this handle manually.
    val.HND_PAINT = 0;

    log_debug(val, "END");
  });
}


/** non-block */
function repainting_with_add(val: storeValue, idx: number, tr: HTMLTableRowElement) {
  val.PAINT_ADD.set(idx, tr);
  if (val.HND_PAINT > 0) return;
  val.HND_PAINT = _repainting(val);
}


/** non-block */
function repainting_with_sadd(val: storeValue, idx: number, h: number) {
  val.PAINT_SADD.set(idx, h);
  if (val.HND_PAINT > 0) return;
  val.HND_PAINT = _repainting(val);
}


/** non-block */
function repainting_with_replace(val: storeValue, idx: number, tr: HTMLTableRowElement){
  val.PAINT_REPLACE.set(idx, tr);
  if (val.HND_PAINT > 0) return;
  val.HND_PAINT = _repainting(val);
}


/** non-block */
function repainting_with_free(val: storeValue, idx: number) {
  val.PAINT_FREE.add(idx);
  if (val.HND_PAINT > 0) return;
  val.HND_PAINT = _repainting(val);
}


function log_debug(val: storeValue & obj, msg: string) {
  if (val.debug) {
    val = { ...val };
    const ts = new Date().getTime();
    console.debug(`%c[${val.id}][${ts}][${msg}] vt`, "color:#a00", val);
    if (val._lstoreval)
      console.debug(`%c[${val.id}][${ts}][${msg}] vt-fixedleft`, "color:#a00", val._lstoreval);
    if (val._rstoreval)
      console.debug(`%c[${val.id}][${ts}][${msg}] vt-fixedright`, "color:#a00", val._rstoreval);
  }
}


function set_tr_cnt(values: storeValue, n: number) {
  values.re_computed = n - values.row_count;
  values.row_count = n;
}


type ShadowRowProps = { idx: number, val: storeValue };

/**
 * a class hepler of `VTRow` for using the life hooks.
 */
class ShadowRow extends React.PureComponent<ShadowRowProps> {
  constructor(props: ShadowRowProps) {
    super(props);
  }
  render(): null {
    return null;
  }
  componentDidMount() {
    const h = this.props.val.row_height[this.props.idx];
    repainting_with_sadd(
      this.props.val,
      this.props.idx,
      h >= 0 ? h : this.props.val.possible_hight_per_tr);
  }
  componentWillUnmount() {
    repainting_with_free(this.props.val, this.props.idx);
  }
}


class VT_CONTEXT {

// using closure
public static Switch(ID: number) {

const values = store.get(ID);

const S = React.createContext<vt_ctx>({ head: 0, tail: 0, fixed: -1 });


type VTRowProps = {
  children: any[]
};

class VTRow extends React.Component<VTRowProps> {

  private inst: React.RefObject<HTMLTableRowElement>;
  private fixed: e_fixed;

  public constructor(props: VTRowProps, context: any) {
    super(props, context);
    this.inst = React.createRef();

    this.fixed = e_fixed.UNKNOW;

  }

  public render() {
    const { children, ...restProps } = this.props;
    return (
      <S.Consumer>
        {
          ({ fixed }) => {
            if (this.fixed === e_fixed.UNKNOW) this.fixed = fixed;
            return <tr {...restProps} ref={this.inst}>{children}</tr>;
          }
        }
      </S.Consumer>
    )
  }

  public componentDidMount() {
    if (this.fixed !== e_fixed.NEITHER) return;

    if (values.load_the_trs_once === e_vt_state.RUNNING) {
      repainting_with_add(values,
        this.props.children[0]!.props!.index,
        this.inst.current);
    } else {
      console.assert(values.load_the_trs_once === e_vt_state.INIT);
      values.load_the_trs_once = e_vt_state.LOADED;
      apply_h_with(
        WAY_ADD,
        values,
        this.props.children[0]!.props!.index,
        this.inst.current.offsetHeight);
    }
  }

  public shouldComponentUpdate(nextProps: VTRowProps, nextState: any) {
    return true;
  }

  public componentDidUpdate() {
    if (this.fixed !== e_fixed.NEITHER) return;
    repainting_with_replace(values, this.props.children[0]!.props!.index, this.inst.current);
  }

  public componentWillUnmount() {
    if (this.fixed !== e_fixed.NEITHER) return;
    repainting_with_free(values, this.props.children[0]!.props!.index);
  }

}


type VTWrapperProps = {
  children: any[];
};


class VTWrapper extends React.Component<VTWrapperProps> {

  private cnt: number;
  private VTWrapperRender: (...args: any[]) => JSX.Element;

  private fixed: e_fixed;

  public constructor(props: VTWrapperProps, context: any) {
    super(props, context);
    this.cnt = 0;

    this.VTWrapperRender = null;

    if (env & _brower) {
      const p: any = window;
      p["&REACT_DEBUG"] && p[`&REACT_HOOKS${p["&REACT_DEBUG"]}`][15] && (this.VTWrapperRender = (...args) => <tbody {...args[3]}>{args[2]}</tbody>);
    }

    this.fixed = e_fixed.UNKNOW;
  }

  public render() {
    const { children, ...restProps } = this.props;
    return (
      <S.Consumer>
        {
          ({ head, tail, fixed }) => {
            
            if (this.fixed < 0) this.fixed = fixed;

            if ((this.cnt !== children.length) && (fixed === e_fixed.NEITHER)) {
              set_tr_cnt(values, children.length);
              this.cnt = children.length;
            }

            if (this.VTWrapperRender) {
              return this.VTWrapperRender(head, tail, children, restProps);
            }

            let ShadowRows;
            let trs;
            let len = children.length;

            if (len) {
              if (tail > len) {
                let offset = tail - len;
                tail -= offset;
                head -= offset;
                if (head < 0) head = 0;
                if (tail < 0) tail = 0;
              }

              if (values.load_the_trs_once === e_vt_state.RUNNING
               && this.fixed === e_fixed.NEITHER)
              {
                ShadowRows = [];
                for (let i = 0; i < head; ++i) {
                  ShadowRows.push(
                    <ShadowRow key={children[i].key} val={values} idx={i}></ShadowRow>);
                }
                for (let i = tail; i < len; ++i) {
                  ShadowRows.push(
                    <ShadowRow key={children[i].key} val={values} idx={i}></ShadowRow>);
                }
              }

              trs = [];
              for (let i = head; i < tail; ++i) {
                trs.push(children[i]);
              }
            }

            return (
              <>
                <tbody {...restProps}>{trs}</tbody>
                {ShadowRows}
              </>
            );
          }
        }
      </S.Consumer>
    );
  }

  public shouldComponentUpdate(nextProps: VTWrapperProps, nextState: any) {
    return true;
  }

}




type VTProps = {
  children: any[];
  style: React.CSSProperties;
} & obj;

class VT extends React.Component<VTProps, {
  top: number;
  head: number;
  tail: number;
}> {

  private inst: React.RefObject<HTMLTableElement>;
  private wrap_inst: React.RefObject<HTMLDivElement>;
  private scrollTop: number;
  private scrollLeft: number;
  private fixed: e_fixed;


  private user_context: obj;


  private event_queue: Array<SimEvent>;
  // the Native EVENT of the scrolling.
  private nevent_queue: Array<Event>;

  private restoring: boolean;

  private cached_height: number;
  private HNDID_TIMEOUT: number;

  // HandleId of requestAnimationFrame.
  private HNDID_RAF: number;

  public constructor(props: VTProps, context: any) {
    super(props, context);
    this.inst = React.createRef();
    this.wrap_inst = React.createRef();
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.restoring = false;
    this.state = {
      top: 0,
      head: 0,
      tail: 1,
    };

    const fixed = this.props.children[0].props.fixed;
    if (fixed === "left") {
      this.fixed = e_fixed.L;
      store.set(0 - ID, { _React_ptr: this } as storeValue);
    } else if (fixed === "right") {
      this.fixed = e_fixed.R;
      store.set((1 << 31) + ID, { _React_ptr: this } as storeValue);
    } else {
      this.fixed = e_fixed.NEITHER;
      values._React_ptr = this; // always set. even if it is `NEITHER`.
    }



    if (this.fixed === e_fixed.NEITHER) {

      if (values.load_the_trs_once !== e_vt_state.SUSPENDED) {
        values.possible_hight_per_tr = -1;
        values.computed_h = 0;
        values.re_computed = 0;
        values.row_height = [];
        values.row_count = 0;
      }
      values.VTRefresh = this.refresh.bind(this);
      values.VTScroll = this.scroll.bind(this);
      values.load_the_trs_once = e_vt_state.INIT;

      this.user_context = {};

      let reflection = values.reflection || [];
      if (typeof reflection === "string") {
        reflection = [reflection];
      }
  
      for (let i = 0; i < reflection.length; ++i) {
        this.user_context[reflection[i]] = this.props[reflection[i]];
      }
  
      this.event_queue = [];
      this.nevent_queue = [];
      this.update_self = this.update_self.bind(this);

      this.HNDID_TIMEOUT = -1;
      this.HNDID_RAF = 0;
    }


    // init store, all of the `L` `R` and `NEITHER`.
    values.WH = 0;

    if (this.fixed === e_fixed.NEITHER) {
      values.PAINT_ADD = new Map();
      values.PAINT_SADD = new Map();
      values.PAINT_REPLACE = new Map();
      values.PAINT_FREE = new Set();
      values.HND_PAINT = 0;
    }

  }

  public render() {
    const { head, tail, top } = this.state;

    const { style, children, ...rest } = this.props;
    style.position = "absolute";
    style.top = top;
    const { width, ...rest_style } = style;

    return (
      <div
        ref={this.wrap_inst}
        style={{ width, position: "relative", transform: "matrix(1, 0, 0, 1, 0, 0)" }}
      >
        <table {...rest} ref={this.inst} style={rest_style}>
          <S.Provider value={{ tail, head, fixed: this.fixed, ...this.user_context }}>{children}</S.Provider>
        </table>
      </div>
    );

  }

  public componentDidMount() {
    switch (this.fixed) {
      case e_fixed.L:
        values._lstoreval = store.get(0 - ID);        // registers the `_lstoreval` at the `values`.
        values._lstoreval.wrap_inst = this.wrap_inst;
        _Update_wrap_style(values._lstoreval, values.computed_h);
        this.wrap_inst.current.setAttribute("vt-left", `[${ID}]`);
        return;

      case e_fixed.R:
        values._rstoreval = store.get((1 << 31) + ID); // registers the `_rstoreval` at the `values`.
        values._rstoreval.wrap_inst = this.wrap_inst;
        _Update_wrap_style(values._rstoreval, values.computed_h);
        this.wrap_inst.current.setAttribute("vt-right", `[${ID}]`);
        return;

      default:
        values.wrap_inst = this.wrap_inst;
        // values.re_computed = 0;
        this.wrap_inst.current.parentElement.onscroll = this.scrollHook.bind(this);
        _Update_wrap_style(values, values.computed_h);
        this.wrap_inst.current.setAttribute("vt", `[${ID}]`);
        break;
    }

    // 0 - head, 2 - body
    if (this.props.children[2].props.children.length) {
      // `load_the_trs_once` is changed by `VTRow`.
      console.assert(values.load_the_trs_once === e_vt_state.LOADED);

      values.load_the_trs_once = e_vt_state.RUNNING;
      this.scrollHook({
        target: { scrollTop: 0, scrollLeft: 0 },
        flags: SCROLLEVT_INIT,
      });

    } else {
      console.assert(values.load_the_trs_once === e_vt_state.INIT);
    }

  }

  public componentDidUpdate() {

    if (this.fixed !== e_fixed.NEITHER) return;

    if (values.load_the_trs_once === e_vt_state.INIT) {
      return;
    }

    if (values.load_the_trs_once === e_vt_state.LOADED) {
      values.load_the_trs_once = e_vt_state.RUNNING;

      // force update for initialization
      this.scrollHook({
        target: { scrollTop: 0, scrollLeft: 0 },
        flags: SCROLLEVT_INIT,
      });
    }

    if (values.load_the_trs_once === e_vt_state.RUNNING) {
      if (this.restoring) {
        this.restoring = false;
        this.scrollHook({
          target: { scrollTop: this.scrollTop, scrollLeft: this.scrollLeft },
          flags: SCROLLEVT_RESTORETO,
        });
      }

      if (values.re_computed !== 0) { // rerender
        values.re_computed = 0;
        this.scrollHook({
          target: { scrollTop: this.scrollTop, scrollLeft: this.scrollLeft },
          flags: SCROLLEVT_RECOMPUTE,
        });
      }
    }

  }

  public componentWillUnmount() {
    if (this.fixed !== e_fixed.NEITHER) return;

    if (values.destory) {
      store.delete(0 - ID);        // fixed left
      store.delete((1 << 31) + ID);// fixed right
      store.delete(ID);
    } else {
      values.load_the_trs_once = e_vt_state.SUSPENDED;
    }
    this.setState = (...args) => null;
  }

  public shouldComponentUpdate(nextProps: VTProps, nextState: any) {
    return true;
  }

  private scroll_with_computed(top: number) {

    if (this.HNDID_TIMEOUT < 0) {
      this.cached_height = this.wrap_inst.current.parentElement.offsetHeight;    
    } else {
      clearTimeout(this.HNDID_TIMEOUT);
    }
    this.HNDID_TIMEOUT = setTimeout(() => {
      if (values.load_the_trs_once === e_vt_state.RUNNING)
        this.cached_height = this.wrap_inst.current.parentElement.offsetHeight;
    }, 1000);

    const {
      row_height,
      row_count,
      height = this.cached_height,
      possible_hight_per_tr,
      overscanRowCount
    } = values;

    let overscan = overscanRowCount;


    let accumulate_top = 0, i = 0;
    for (; i < row_count; ++i) {
      if (accumulate_top > top) break;
      accumulate_top += (row_height[i] || possible_hight_per_tr);
    }

    if (i > 0) {
      do {
        accumulate_top -= (row_height[--i] || possible_hight_per_tr);
      } while (overscan-- && i);
    }

    overscan = overscanRowCount * 2;

    let torender_h = 0, j = i;
    for (; j < row_count; ++j) {
      if (torender_h > height) break;
      torender_h += (row_height[j] || possible_hight_per_tr);
    }

    if (j < row_count) {
      do {
        torender_h += (row_height[j++] || possible_hight_per_tr);
      } while ((--overscan > 0) && (j < row_count));
    }

    return [0 | i, 0 | j, 0 | accumulate_top];
  }

  /**
   * @deprecated
   */
  public refresh() {
    const [head, tail, top] = this.scroll_with_computed(this.scrollTop);
    this.setState({ top, head, tail });
  }


  private scrollHook(e: any) {
    if (e && values.debug) {
      console.debug(
        `[${values.id}][scrollHook] scrollTop: %d, scrollLeft: %d`,
        e.target.scrollTop,
        e.target.scrollLeft);
    }

    if (e) {
      if (e.flags) {
        // if (e.flags === SCROLLEVT_RECOMPUTE) {
        //   e.flags |= SCROLLEVT_BARRIER;
        // }
        this.event_queue.push(e);
      } else {
        this.nevent_queue.push(e);
      }
    }

    if (this.nevent_queue.length || this.event_queue.length) {
      if (this.HNDID_RAF) cancelAnimationFrame(this.HNDID_RAF);
      // requestAnimationFrame, ie >= 10
      this.HNDID_RAF = requestAnimationFrame(this.update_self);
    }
  }

  private update_self(timestamp: number) {

    const nevq = this.nevent_queue,
          evq  = this.event_queue;

    let e: SimEvent;
    // consume the `evq` first.
    if (evq.length) {
      e = evq.shift();
    } else if (nevq.length) {
      // take the last event from the `nevq`.
      e = _make_evt(nevq.pop());
      nevq.length = 0;
    } else {
      return;
    }

    // if (e.flags & SCROLLEVT_MASK) {
    //   if (nevq.length) {
    //     e = _make_evt(nevq.pop());
    //     nevq.length = 0;
    //   }
    // }

    let scrollTop = e.target.scrollTop;
    let scrollLeft = e.target.scrollLeft;
    let flags = e.flags;

    if (values.onScroll) {
      values.onScroll({ top: scrollTop, left: scrollLeft });
    }

    // checks every tr's height, so it may be take some times...
    const [head, tail, top] = this.scroll_with_computed(scrollTop);

    const prev_head = this.state.head,
          prev_tail = this.state.tail,
          prev_top = this.state.top;

    if (flags & SCROLLEVT_INIT) {
      log_debug(values, "SCROLLEVT_INIT");

      console.assert(scrollTop === 0 && scrollLeft === 0);

      this.setState({ top, head, tail }, () => {
        this.el_scroll_to(0, 0); // init this vtable by (0, 0).
        this.HNDID_RAF = 0;

        flags &= ~SCROLLEVT_INIT;
        flags &= ~SCROLLEVT_BARRIER;

        if (this.event_queue.length) this.scrollHook(null); // consume the next.
      });

      _RC_fixed_setState(values, top, head, tail);
      return;
    }

    if (flags & SCROLLEVT_RECOMPUTE) {
      log_debug(values, "SCROLLEVT_RECOMPUTE");

      if (head === prev_head && tail === prev_tail && top === prev_top) {
        this.HNDID_RAF = 0;

        flags &= ~SCROLLEVT_BARRIER;
        flags &= ~SCROLLEVT_RECOMPUTE;
        
        if (this.event_queue.length) this.scrollHook(null); // consume the next.
        return;
      }

      this.setState({ top, head, tail }, () => {
        this.el_scroll_to(scrollTop, scrollLeft);
        this.HNDID_RAF = 0;

        flags &= ~SCROLLEVT_BARRIER;
        flags &= ~SCROLLEVT_RECOMPUTE;

        if (this.event_queue.length) this.scrollHook(null); // consume the next.
      });

      _RC_fixed_setState(values, top, head, tail);
      return;
    }

    if (flags & SCROLLEVT_RESTORETO) {
      log_debug(values, "SCROLLEVT_RESTORETO");

      if (head === prev_head && tail === prev_tail && top === prev_top) {
        this.HNDID_RAF = 0;

        flags &= ~SCROLLEVT_BARRIER;
        flags &= ~SCROLLEVT_RESTORETO;
        this.restoring = false;

        if (this.event_queue.length) this.scrollHook(null); // consume the next.
        return;
      }

      this.restoring = true;


      this.setState({ top, head, tail }, () => {
        this.el_scroll_to(scrollTop, scrollLeft);
        this.HNDID_RAF = 0;

        flags &= ~SCROLLEVT_BARRIER;
        flags &= ~SCROLLEVT_RESTORETO;

        this.restoring = false;
        if (this.event_queue.length) this.scrollHook(null); // consume the next.
      });

      _RC_fixed_setState(values, top, head, tail);
      return;
    } 
    
    if (flags & SCROLLEVT_NATIVE) {
      log_debug(values, "SCROLLEVT_NATIVE");

      if (head === prev_head && tail === prev_tail && top === prev_top) {
        this.HNDID_RAF = 0;

        flags &= ~SCROLLEVT_NATIVE;
        return;
      }

      this.scrollLeft = scrollLeft;
      this.scrollTop = scrollTop;

      this.setState({ top, head, tail }, () => {
        this.HNDID_RAF = 0;
        flags &= ~SCROLLEVT_NATIVE;
      });

      _RC_fixed_setState(values, top, head, tail);
      return;
    }
  }

  // returns the last state.
  public scroll(param?: { top: number, left: number }): { top: number, left: number } {

    if (param) {
      if (this.restoring) {
        return {
          top: this.scrollTop,
          left: this.scrollLeft,
        };
      }

      const lst_top = this.scrollTop;
      const lst_left = this.scrollLeft;

      this.restoring = true;

      if (typeof param.top === "number") {
        this.scrollTop = param.top;
      }
      if (typeof param.left === "number") {
        this.scrollLeft = param.left;
      }

      this.forceUpdate();

      return {
        top: lst_top,
        left: lst_left,
      };
    } else {
      return { top: this.scrollTop, left: this.scrollLeft };
    }
  }

  private el_scroll_to(top: number, left: number) {

    let el = values.wrap_inst.current.parentElement;
    /** ie */
    el.scrollTop = top;
    el.scrollLeft = left;

    if (values._lstoreval) {
      el = values._lstoreval.wrap_inst.current.parentElement;
      el.scrollTop = top;
      el.scrollLeft = left;
    }
    if (values._rstoreval) {
      el = values._rstoreval.wrap_inst.current.parentElement;
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }



  public static Wrapper = VTWrapper;

  public static Row = VTRow;
}


return { VT, Wrapper: VTWrapper, Row: VTRow, S };

} // Switch

} // VT_CONTEXT

function ASSERT_ID(id: number) {
  console.assert(typeof id === "number" && id > 0);
}

function init(id: number) {
  const inside = store.get(id) || {} as storeValue;
  if (!inside.components) {
    store.set(id, inside);
    const { VT, Wrapper, Row, S } = VT_CONTEXT.Switch(id);
    inside.components = { table: VT, wrapper: Wrapper, row: Row };
    inside.context = S;
    inside.load_the_trs_once = e_vt_state.INIT;
  }
  return inside;
}



export
function VTComponents(vt_opts: vt_opts): TableComponents {

  ASSERT_ID(vt_opts.id);

  if (Object.hasOwnProperty.call(vt_opts, "height")) {
    console.assert(typeof vt_opts.height === "number" && vt_opts.height >= 0);
  }

  const inside = init(vt_opts.id);


  Object.assign(
    inside,
    {
      overscanRowCount: 5,
      debug: false,
      destory: false,
    } as storeValue,
    vt_opts);

  if (vt_opts.debug) {
    console.debug(`[${vt_opts.id}] calling VTComponents with`, vt_opts);
  }

  return {
    table: inside.components.table,
    body: {
      wrapper: inside.components.wrapper,
      row: inside.components.row
    }
  };
}

export
function getVTContext(id: number) {
  ASSERT_ID(id);
  return init(id).context;
}

export
function getVTComponents(id: number) {
  ASSERT_ID(id);
  return init(id).components;
}

export
function VTScroll(id: number, param?: { top: number, left: number }) {
  ASSERT_ID(id);
  return store.get(id).VTScroll(param);
}

export
function VTRefresh(id: number) {
  console.warn('VTRefresh will be deprecated in next release version.');
  ASSERT_ID(id);
  store.get(id).VTRefresh();
}
