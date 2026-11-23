// The composer's model menu writes to a live session. These choices write only to the role.
function spaceMenuGroups(groups,query) {
  const needle=query.trim().toLowerCase();
  if (!needle) return groups;
  // Keep provider groups and put prefix matches ahead of ordered subsequence matches.
  function rank(row) {
    const name=row.label.toLowerCase();
    if (name.startsWith(needle)) return -1;
    let last=-1,gaps=0;
    for (const char of needle) {
      const at=name.indexOf(char,last+1);
      if (at<0) return Infinity;
      gaps+=at-last-1;last=at;
    }
    return gaps;
  }
  // The ungrouped inheritance control is not a provider model and must never win a search.
  return groups.filter(g=>g.key!=null).map(g=>({...g,options:g.options.map(row=>({row,score:rank(row)}))
    .filter(x=>Number.isFinite(x.score)).sort((a,b)=>a.score-b.score).map(x=>x.row)})).filter(g=>g.options.length);
}

function spaceMenuBounds(anchor,view,wantHeight,wantWidth,modelMenu=false) {
  const pad=modelMenu?12:8, gap=modelMenu?8:4, left=view.left+pad, top=view.top+pad;
  const right=view.left+view.width-pad, bottom=view.top+view.height-pad;
  const clamp=(v,min,max)=>Math.max(min,Math.min(v,max));
  const width=Math.min(wantWidth,Math.max(1,right-left));
  const start=clamp(anchor.bottom+gap,top,bottom), end=clamp(anchor.top-gap,top,bottom);
  const down=bottom-start, up=end-top;
  const above=(modelMenu && up>=wantHeight) || (down<wantHeight && up>down);
  const height=Math.min(wantHeight,above ? up : down);
  return {left:clamp(modelMenu ? anchor.right-width : anchor.left,left,right-width),top:above ? end-height : start,width,height};
}

function spaceMenuScrollDelta(row,list,pinnedHeight) {
  if (row.bottom>list.bottom) return row.bottom-list.bottom;
  const visibleTop=list.top+Math.min(pinnedHeight,Math.max(0,list.height-row.height));
  return Math.min(0,row.top-visibleTop);
}

function SpaceSelect(props) {
  const {label,value,onChange,groups,disabled}=props;
  if (typeof HTMLElement==='undefined' || !('showPopover' in HTMLElement.prototype))
    return h('select',{'aria-label':label,value,disabled,onChange:e=>onChange(e.target.value)},groups.map((g,i)=>{
      const options=g.options.map(o=>h('option',{key:o.value,value:o.value,disabled:o.disabled},o.label));
      return g.label ? h('optgroup',{key:g.key ?? i,label:g.label},options) : options;
    }));
  return h(SpaceRoleMenu,props);
}

function spaceRolePane(pages,drill) {
  if (!pages) return 'single';
  if (!pages.root || drill==='model') return 'model';
  return drill==='effort' && pages.root[0].options.some(o=>o.value==='effort') ? 'effort' : 'root';
}

function SpaceRoleMenu({label,value,inheritedLabel,onChange,onEffort,tr,groups,pages,disabled}) {
  const id=React.useId(), button=React.useRef(null), panel=React.useRef(null), input=React.useRef(null), list=React.useRef(null);
  const [open,setOpen]=React.useState(false),[query,setQuery]=React.useState(''),[cursor,setCursor]=React.useState(null);
  const [drill,setDrill]=React.useState(null);
  const pane=spaceRolePane(pages,drill);
  const root=pane==='root',effort=pane==='effort',search=pane==='model' && pages.search;
  const options=root ? pages.root : effort ? pages.effort.groups : groups;
  const current=root ? null : effort ? pages.effort.value : value;
  const visible=open ? spaceMenuGroups(options,search ? query : '') : [];
  const enabled=visible.flatMap(g=>g.options.filter(o=>!o.disabled));
  const selected=groups.flatMap(g=>g.options).find(o=>o.value===value);
  const display=value==='' && inheritedLabel ? inheritedLabel : selected?.label;
  const active=enabled.some(o=>o.value===cursor) ? cursor :
    (!query && !root ? enabled.find(o=>o.value===current)?.value : undefined) ?? (root ? null : enabled[0]?.value);
  const activeIndex=enabled.findIndex(o=>o.value===active);
  const activeId=activeIndex<0 ? undefined : id+'-opt-'+activeIndex;
  const focusRow=()=>list.current?.querySelector('[data-active="true"]')?.focus({preventScroll:true});
  const close=()=>{panel.current?.hidePopover();button.current?.focus({preventScroll:true})};
  function navigate(next,focus=null) {setQuery('');setCursor(focus);setDrill(next)}
  function choose(o) {
    if (!o || o.disabled || disabled) return;
    if (root) {navigate(o.value);return}
    close();if(o.value!==current)(effort ? onEffort : onChange)(o.value);
  }
  React.useLayoutEffect(()=>{
    const el=panel.current;
    const toggle=()=>{const shown=el.matches(':popover-open');setOpen(shown);if(!shown)navigate(null)};
    el.addEventListener('toggle',toggle);
    return ()=>el.removeEventListener('toggle',toggle);
  },[]);
  React.useLayoutEffect(()=>{
    if (!open) return;
    const el=panel.current, scroll=list.current, vv=window.visualViewport;
    const place=()=>{
      const v={left:vv?.offsetLeft ?? 0,top:vv?.offsetTop ?? 0,width:vv?.width ?? document.documentElement.clientWidth,height:vv?.height ?? window.innerHeight};
      const chrome=pages ? 8+(input.current?.parentElement.offsetHeight || 0) : 12;
      if (pages) {
        el.style.minWidth=Math.max(1,Math.min(240,v.width-24))+'px';
        el.style.maxWidth=Math.max(1,Math.min(420,v.width-24))+'px';
      }
      const wanted=Math.min(pages ? Math.min(360,Math.max(80,v.height-96)) : 370,chrome+scroll.firstElementChild.offsetHeight+(el.querySelector('[role="status"]')?.offsetHeight || 0));
      const box=spaceMenuBounds(button.current.getBoundingClientRect(),v,wanted,pages ? el.offsetWidth : 238,!!pages);
      if (!pages) el.style.width=box.width+'px';
      Object.assign(el.style,{left:box.left+'px',top:box.top+'px',maxHeight:box.height+'px'});
    };
    const reposition=e=>{if(!el.contains(e.target instanceof Node ? e.target : null)) place()};
    place();
    const observer=new ResizeObserver(place);
    observer.observe(scroll.firstElementChild);observer.observe(button.current);
    window.addEventListener('scroll',reposition,true);window.addEventListener('resize',place);
    vv?.addEventListener('resize',place);vv?.addEventListener('scroll',place);
    return ()=>{observer.disconnect();window.removeEventListener('scroll',reposition,true);window.removeEventListener('resize',place);
      vv?.removeEventListener('resize',place);vv?.removeEventListener('scroll',place)};
  },[open,pane,search]);
  React.useLayoutEffect(()=>{
    if (!open) return;
    if (search && !window.matchMedia('(pointer: coarse)').matches) input.current?.focus({preventScroll:true});
    else if (list.current?.querySelector('[data-active="true"]')) focusRow();
    else panel.current.focus({preventScroll:true});
  },[open,pane,search]);
  React.useLayoutEffect(()=>{
    if (!open) return;
    const row=list.current?.querySelector('[data-active="true"]');
    if (!row) return;
    const header=pane==='model' ? row.closest('[role="group"]')?.querySelector('.x2-menu-group') : null;
    const delta=spaceMenuScrollDelta(row.getBoundingClientRect(),list.current.getBoundingClientRect(),header?.offsetHeight || 0);
    if (delta) list.current.scrollTop+=delta;
  },[open,pane,active,query]);
  function keyDown(e) {
    if (e.nativeEvent.isComposing || e.keyCode===229) return;
    if (e.key==='Escape') {
      e.preventDefault();e.stopPropagation();
      if (pages?.root && !root) navigate(null,pane); else close();
      return;
    }
    const typing=e.target===input.current;
    if (e.key==='Tab') {
      // Keep the search field and its clear button reachable from each other.
      if (search && query && (typing && !e.shiftKey || e.shiftKey && e.target.closest('.x2-model-clear'))) return;
      close();return;
    }
    if (typing && e.key==='Enter') {e.preventDefault();choose(enabled[activeIndex]);return}
    if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key) || typing && ['Home','End'].includes(e.key) || !enabled.length) return;
    e.preventDefault();
    const direction=e.key==='ArrowUp' ? -1 : 1;
    const idx=e.key==='Home' ? 0 : e.key==='End' ? enabled.length-1 : activeIndex<0 ? (direction>0 ? 0 : enabled.length-1) : (activeIndex+direction+enabled.length)%enabled.length;
    setCursor(enabled[idx].value);
    if (!typing) list.current.querySelectorAll('button:not(:disabled)')[idx]?.focus({preventScroll:true});
  }
  let index=0;
  return h(React.Fragment,null,h('button',{type:'button',ref:button,disabled:pages ? undefined : disabled,'aria-disabled':pages && disabled || undefined,className:'x2-role-trigger',popoverTarget:disabled ? undefined : id,
    'aria-label':label+tr('：',': ')+(display || ''),'aria-haspopup':pages?'menu':'dialog','aria-controls':id,'aria-expanded':open,
    onKeyDown:e=>{if(!disabled && (e.key==='ArrowDown' || e.key==='ArrowUp')){e.preventDefault();panel.current?.showPopover()}}},
    h('span',null,display),h(Mark,{name:'chevron',size:12})),
    h('div',{id,ref:panel,popover:'auto',tabIndex:-1,role:pages?'group':'dialog',className:'x2-role-menu'+(pages?' x2-model-menu':''),'data-menu-material':'translucent','aria-label':label,onKeyDown:keyDown,
      onBlur:e=>{if(e.relatedTarget && !e.currentTarget.contains(e.relatedTarget) && e.relatedTarget!==button.current && panel.current.matches(':popover-open')) panel.current.hidePopover()}},
      search && h('div',{className:'x2-model-search'},h('input',{type:'text',className:'x2-menu-search',ref:input,value:query,role:'searchbox',placeholder:tr('搜索模型…','Search models…'),
        'aria-label':tr('搜索模型','Search models'),'aria-controls':id+'-list','aria-activedescendant':activeId,
        onChange:e=>{setQuery(e.target.value);setCursor(null)}}),query && h('button',{type:'button',className:'x2-model-clear','aria-label':tr('清除搜索','Clear search'),
          onClick:()=>{setQuery('');setCursor(null);input.current?.focus()}},'×')),
      h('div',{ref:list,id:id+'-list',className:'x2-menu-scroll',role:pages?'menu':'listbox','aria-label':label},
        h('div',{role:'presentation'},visible.map((g,i)=>h('div',{role:'group',key:g.key ?? i,'aria-label':g.label || undefined},
          g.label && h('div',{className:'x2-menu-group','aria-hidden':true},g.label),
          g.options.map(o=>h('button',{type:'button',role:root?'menuitem':pages?'menuitemradio':'option',id:o.disabled ? undefined : id+'-opt-'+index++,key:o.value,tabIndex:-1,
            disabled:o.disabled,'aria-selected':pages?undefined:o.value===value,'aria-checked':pages&&!root?o.value===current:undefined,'aria-haspopup':root?'menu':undefined,
            'data-active':o.value===active,'data-chosen':o.value===current,title:pages?(o.detail || o.label):undefined,
            onMouseMove:pages&&!root&&!o.disabled?e=>{if (search) setCursor(o.value);else e.currentTarget.focus({preventScroll:true})}:undefined,onFocus:()=>setCursor(o.value),onClick:()=>choose(o)},h('span',null,o.label),
            root ? h(React.Fragment,null,h('span',{className:'x2-model-current'},o.detail),h(Mark,{name:'chevron',size:12})) :
              o.value===current && h(Mark,{name:'check',size:pages?14:16}))))))),
      open && !visible.length && h('p',{role:'status',className:'x2-menu-empty'},tr('没有匹配的模型。','No matching models.'))));
}
