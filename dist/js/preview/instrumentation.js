  // Inspect mode never edits the user's source. Temporary identifiers exist
  // only in the iframe's srcdoc, and are stripped from downloads by design.
export function mapSourceTags(source) {
    const starts = [], ranges = [], parts = [], stack = [], scripts = [];
    let hasBootstrap = false;
    const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
    const rawTags = new Set(['script','style','textarea','title','xmp','iframe','noembed','noframes','plaintext']);
    let scan = 0, copied = 0;
    while (scan < source.length) {
      const at = source.indexOf('<', scan);
      if (at < 0) break;
      if (source.startsWith('<!--', at)) {
        const end = source.indexOf('-->', at + 4);
        scan = end < 0 ? source.length : end + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', at)) {
        const end = source.indexOf(']]>', at + 9);
        scan = end < 0 ? source.length : end + 3;
        continue;
      }
      const ending = /^<\/([A-Za-z][\w:-]*)\b/.exec(source.slice(at, at + 90));
      if (ending) {
        const closeEnd = source.indexOf('>', at + ending[0].length);
        if (closeEnd < 0) break;
        const tag = ending[1].toLowerCase();
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tag === tag) {
            ranges[stack[i].index].to = closeEnd + 1;
            stack.length = i; // Discard any unclosed children of this element.
            break;
          }
        }
        scan = closeEnd + 1;
        continue;
      }
      const match = /^<([A-Za-z][\w:-]*)\b/.exec(source.slice(at, at + 90));
      if (!match) { scan = at + 1; continue; }
      let end = at + match[0].length, quote = '';
      for (; end < source.length; end++) {
        const c = source[end];
        if (quote) { if (c === quote) quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (end >= source.length) break;
      const tag = match[1].toLowerCase();
      const openingTag = source.slice(at,end+1);
      let runnableScript = false;
      if (tag === 'script' && !/\bsrc\s*=/i.test(openingTag)) {
        const typeMatch = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openingTag);
        const type = (typeMatch ? (typeMatch[1] || typeMatch[2] || typeMatch[3] || '') : '').toLowerCase().trim();
        runnableScript = !type || type === 'module' || type === 'text/javascript' || type === 'application/javascript';
      }
      // One-line injected bootstrap preserves the original script line numbers.
      if (runnableScript && !hasBootstrap) {
        parts.push(source.slice(copied,at),'__HP_SCRIPT_BOOTSTRAP__');
        copied = at;
        hasBootstrap = true;
      }
      let insertAt = end, back = end - 1;
      while (back > at && /\s/.test(source[back])) back--;
      const selfClosing = source[back] === '/';
      if (selfClosing) insertAt = back;
      parts.push(source.slice(copied, insertAt));
      parts.push(' data-hp-source="', String(starts.length), '"');
      copied = insertAt;
      const index = starts.length;
      if (runnableScript) scripts.push({id:index,from:at});
      starts.push(at);
      ranges.push({from:at,to:end+1}); // Void and unmatched tags highlight only the opening tag.
      if (!selfClosing && !voidTags.has(tag)) stack.push({tag,index});
      scan = end + 1;
      // Raw text isn't HTML: skip script/style content (including JS '<' operators).
      if (rawTags.has(tag)) {
        const rest = source.slice(scan);
        const close = new RegExp('<\\/' + tag + '(?=[\\s>])', 'i').exec(rest);
        scan = close ? scan + close.index : source.length;
      }
    }
    parts.push(source.slice(copied));
    return {
      html:parts.join(''), positions:starts, ranges,
      scripts:scripts.map(item => ({
        id:item.id,
        start:source.slice(0,item.from).split('\n').length,
        end:source.slice(0,ranges[item.id].to).split('\n').length
      }))
    };
  }

  // This small preview-only hook records which inline script creates DOM nodes.
  // Script stack locations map to source line numbers; no user code is modified.
export function previewScriptAttribution(scripts) {
    const owners = new WeakMap();
    function origin() {
      const lines = String(new Error().stack || '').split('\n');
      for (let i = 3; i < lines.length; i++) {
        const match = /about:srcdoc:(\d+):\d+/.exec(lines[i]);
        if (!match) continue;
        const line = Number(match[1]);
        const found = scripts.find(script => script.start <= line && line <= script.end);
        if (found) return found.id;
      }
      return null;
    }
    function tag(element, id) {
      if (id !== null && element instanceof Element) owners.set(element,id);
    }
    const create = Document.prototype.createElement;
    Document.prototype.createElement = function(...args) {
      const element = create.apply(this,args);
      tag(element,origin());
      return element;
    };
    const createNS = Document.prototype.createElementNS;
    Document.prototype.createElementNS = function(...args) {
      const element = createNS.apply(this,args);
      tag(element,origin());
      return element;
    };
    const adjacent = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function(position, markup) {
      const parentNode = /^(beforebegin|afterend)$/i.test(position) ? this.parentElement : this;
      const previous = parentNode ? new Set(parentNode.children) : null;
      const id = origin();
      const result = adjacent.call(this,position,markup);
      if (id !== null && parentNode && previous) {
        for (const node of parentNode.children) if (!previous.has(node)) tag(node,id);
      }
      return result;
    };
    window.__hpScriptOwnerFor = function(element) {
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        if (owners.has(node)) return owners.get(node);
      }
      return null;
    };
  }

  // Executes in a cross-origin, sandboxed iframe and sends only source IDs.
  // Its event handlers are inert until the user enables Inspect.
  // The box-model overlay lives in the sandboxed preview. It uses its own
  // Shadow DOM so arbitrary page CSS can't restyle the inspection overlay.
  // Geometry is measured in the iframe's CSS pixels (before parent zoom).
export function previewInspector(session) {
    let enabled = false, hovered = null, selected = null, detailsVisible = false;
    const marker = '[data-hp-source]';
    const overlay = document.createElement('div');
    overlay.id = 'hp-inspect-overlay';
    overlay.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    const shadow = overlay.attachShadow({mode:'open'});
    const css = document.createElement('style');
    css.textContent =
      '.hp-region{position:absolute;pointer-events:none;box-sizing:border-box}' +
      '.hp-margin{background:rgba(246,171,93,.36)}' +
      '.hp-border{background:rgba(247,213,105,.48)}' +
      '.hp-padding{background:rgba(130,201,103,.36)}' +
      '.hp-content{background:rgba(75,155,232,.19)}' +
      '.hp-outline{position:absolute;pointer-events:none;box-sizing:border-box;outline:1.5px solid #397be8}' +
      '.hp-script-outline{position:absolute;pointer-events:none;box-sizing:border-box;outline:2px solid #397be8;background:rgba(75,155,232,.08);border-radius:3px}' +
      '.hp-label{position:absolute;pointer-events:none;box-sizing:border-box;max-width:calc(100vw - 8px);' +
      'background:#2563eb;color:#fff;border-radius:5px;padding:4px 7px;' +
      'font:500 11px/1.3 system-ui,-apple-system,sans-serif;white-space:nowrap;' +
      'overflow:hidden;text-overflow:ellipsis;box-shadow:0 3px 8px #0b2b5a26}';
    shadow.append(css);
    const regions = {};
    for (const name of ['margin','border','padding']) {
      regions[name] = [];
      for (let i=0;i<4;i++) {
        const piece = document.createElement('div');
        piece.className = 'hp-region hp-' + name;
        piece.hidden = true;
        shadow.append(piece);
        regions[name].push(piece);
      }
    }
    const content = document.createElement('div'); content.className='hp-region hp-content'; content.hidden=true;
    const outline = document.createElement('div'); outline.className='hp-outline'; outline.hidden=true;
    const badge = document.createElement('div'); badge.className='hp-label'; badge.hidden=true;
    shadow.append(content,outline,badge);
    const scriptOutlines = Array.from({length:24}, () => {
      const piece=document.createElement('div');
      piece.className='hp-script-outline'; piece.hidden=true; shadow.append(piece);
      return piece;
    });
    const pieces = [...regions.margin,...regions.border,...regions.padding,content,outline,badge,...scriptOutlines];
    let sourceTargets = []; // Current Editor → Preview selection; never modifies the DOM under inspection.
    function mount() {
      if (!overlay.isConnected && document.documentElement) document.documentElement.appendChild(overlay);
    }
    function hide() { for (const node of pieces) node.hidden=true; }
    function box(node,x,y,w,h) {
      if (![x,y,w,h].every(Number.isFinite) || w<=0.01 || h<=0.01) { node.hidden=true; return; }
      node.hidden=false;
      Object.assign(node.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});
    }
    function ring(pieces,outer,top,right,bottom,left) {
      box(pieces[0],outer.x,outer.y,outer.w,top);
      box(pieces[1],outer.x+outer.w-right,outer.y+top,right,Math.max(0,outer.h-top-bottom));
      box(pieces[2],outer.x,outer.y+outer.h-bottom,outer.w,bottom);
      box(pieces[3],outer.x,outer.y+top,left,Math.max(0,outer.h-top-bottom));
    }
    function sides(style,prefix,suffix='') {
      return ['Top','Right','Bottom','Left'].map(side => style[prefix+side+suffix]);
    }
    function numbers(values) { return values.map(v => Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0); }
    function labelFor(el) {
      const classes=typeof el.className==='string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
      return el.tagName.toLowerCase() + (el.id?'#'+el.id:'') + (classes[0]?'.'+classes[0]:'');
    }
    function fmt(num) { return String(Math.round(num*10)/10); }
    function geometry(el) {
      const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
      const scaleX=rect.width/(el.offsetWidth||rect.width||1);
      const scaleY=rect.height/(el.offsetHeight||rect.height||1);
      const margins=sides(style,'margin');
      const borders=sides(style,'border','Width');
      const paddings=sides(style,'padding');
      const radii=['TopLeft','TopRight','BottomRight','BottomLeft'].map(corner=>style['border'+corner+'Radius']);
      // Only surface typography when this element actually contains readable text.
      // Containers with only nested elements don't need the extra rows.
      const textTag=/^(H[1-6]|P|SPAN|A|BUTTON|LABEL|LI|EM|STRONG|B|I|SMALL|CODE|PRE|BLOCKQUOTE|TD|TH|CAPTION|SUMMARY|DT|DD|TIME|MARK)$/i.test(el.tagName);
      const directText=Array.from(el.childNodes).some(node=>node.nodeType===3 && node.textContent.trim());
      const font=(directText||(textTag && el.textContent.trim())) ? {
        family:style.fontFamily,size:style.fontSize,weight:style.fontWeight,
        italic:style.fontStyle,lineHeight:style.lineHeight,color:style.color
      } : null;
      return {rect,margins,borders,paddings,radii,font,
        m:numbers(margins).map((n,i)=>Math.max(0,n)*(i%2?scaleX:scaleY)),
        b:numbers(borders).map((n,i)=>Math.max(0,n)*(i%2?scaleX:scaleY)),
        p:numbers(paddings).map((n,i)=>Math.max(0,n)*(i%2?scaleX:scaleY))};
    }
    // Share the same measurements between Preview → Editor and Editor → Preview.
    function metricsFor(el, point=null) {
      if (!el || !el.isConnected) return null;
      const info=geometry(el),r=info.rect;
      if (r.width<0.1 || r.height<0.1) return null;
      return {tag:labelFor(el),width:fmt(r.width),height:fmt(r.height),
        margin:info.margins,border:info.borders,padding:info.paddings,radius:info.radii,font:info.font,
        anchor:{
          x:point?.x ?? Math.max(0,Math.min(innerWidth,r.left+Math.min(r.width/2,90))),
          y:point?.y ?? Math.max(0,Math.min(innerHeight,r.top+Math.min(r.height/2,20))),
          top:r.top,bottom:r.bottom
        }};
    }
    function paint(el) {
      if (!enabled || !el || !el.isConnected) {hide();return;}
      mount();
      const info=geometry(el),r=info.rect;
      if (r.width<0.1 || r.height<0.1) {hide();return;}
      const [mt,mr,mb,ml]=info.m,[bt,br,bb,bl]=info.b,[pt,pr,pb,pl]=info.p;
      // Margin strips lie outside the border box; negative margins are reported
      // numerically but cannot be drawn as an outer band.
      ring(regions.margin,{x:r.left-ml,y:r.top-mt,w:r.width+ml+mr,h:r.height+mt+mb},mt,mr,mb,ml);
      ring(regions.border,{x:r.left,y:r.top,w:r.width,h:r.height},bt,br,bb,bl);
      const inner={x:r.left+bl,y:r.top+bt,w:Math.max(0,r.width-bl-br),h:Math.max(0,r.height-bt-bb)};
      ring(regions.padding,inner,pt,pr,pb,pl);
      box(content,inner.x+pl,inner.y+pt,Math.max(0,inner.w-pl-pr),Math.max(0,inner.h-pt-pb));
      box(outline,r.left,r.top,r.width,r.height);
      // The details popover already contains the name and size. Avoid overlapping badges.
      badge.hidden=detailsVisible;
      if (!detailsVisible) {
        badge.textContent=labelFor(el)+' · '+fmt(r.width)+' × '+fmt(r.height);
        const bw=badge.getBoundingClientRect().width || badge.offsetWidth || 150;
        const bh=badge.getBoundingClientRect().height || badge.offsetHeight || 23;
        badge.style.left=Math.max(4,Math.min(r.left,innerWidth-bw-4))+'px';
        badge.style.top=(r.top>=bh+7 ? r.top-bh-5 : Math.min(innerHeight-bh-4,r.bottom+5))+'px';
      }
    }
    function draw() {
      const target=hovered?.isConnected ? hovered : sourceTargets[0]?.isConnected ? sourceTargets[0] : selected;
      paint(target);
      // A script may generate multiple sibling components. Show one full box model
      // and unobtrusive outlines on the remaining roots, rather than a noisy panel.
      let extra=0;
      if (enabled && !hovered && sourceTargets.length>1) {
        for (const el of sourceTargets.slice(1)) {
          if (extra >= scriptOutlines.length) break;
          if (!el.isConnected) continue;
          const r=el.getBoundingClientRect();
          if (r.width>0 && r.height>0) box(scriptOutlines[extra++],r.left,r.top,r.width,r.height);
        }
      }
      for (let i=extra;i<scriptOutlines.length;i++) scriptOutlines[i].hidden=true;
    }
    function targetsForSource(id,kind) {
      if (!Number.isSafeInteger(id) || id<0) return [];
      if (kind==='html') {
        const el=document.querySelector('[data-hp-source="'+id+'"]');
        return el ? [el] : [];
      }
      if (kind!=='script' || typeof window.__hpScriptOwnerFor!=='function') return [];
      const roots=[];
      // Inspecting one script should not accidentally select unrelated page content.
      // Only nodes explicitly attributed to the script are included.
      const owner=window.__hpScriptOwnerFor;
      let scanned=0;
      for (const el of document.querySelectorAll('body *')) {
        if (++scanned>12000 || roots.length>=25) break;
        if (el.hasAttribute('data-hp-source') || owner(el)!==id) continue;
        if (el.parentElement && owner(el.parentElement)===id) continue;
        roots.push(el);
      }
      return roots;
    }
    window.addEventListener('message',event=>{
      if (event.source!==parent || !event.data || event.data.hpInspect!==session) return;
      if (event.data.type==='mode') {
        enabled=!!event.data.enabled;
        hovered=null;
        if (!enabled) {selected=null;sourceTargets=[];}
        document.documentElement.style.cursor=enabled?'crosshair':'';
        draw();
      } else if (event.data.type==='details-visible') {
        detailsVisible=!!event.data.visible;
        draw();
      } else if (event.data.type==='source-select' && enabled) {
        sourceTargets=targetsForSource(event.data.id,event.data.kind);
        selected=null;
        if (sourceTargets.length && event.data.reveal) {
          const el=sourceTargets[0], r=el.getBoundingClientRect();
          // Scroll only the iframe document, not the surrounding workspace.
          if (r.bottom<12 || r.top>innerHeight-12 || r.right<12 || r.left>innerWidth-12) {
            window.scrollBy({top:r.top-innerHeight/2+Math.min(r.height,innerHeight)/2,
              left:r.left<0 || r.left>innerWidth ? r.left-innerWidth/2 : 0,behavior:'auto'});
          }
        }
        draw();
        parent.postMessage({hpInspect:session,type:'source-metrics',id:event.data.id,
          kind:event.data.kind,metrics:metricsFor(sourceTargets[0])},'*');
      } else if (event.data.type==='source-clear') {
        sourceTargets=[];
        selected=null;
        draw();
        parent.postMessage({hpInspect:session,type:'source-metrics',metrics:null},'*');
      }
    });
    window.addEventListener('pointermove',event=>{
      if (!enabled) return;
      const target=event.target instanceof Element ? event.target : event.target?.parentElement;
      if (target!==hovered) hovered=target;
      draw();
    },true);
    window.addEventListener('pointerout',event=>{
      if (!enabled || event.relatedTarget) return;
      hovered=null;draw();
    },true);
    window.addEventListener('click',event=>{
      if (!enabled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const el=event.target instanceof Element ? event.target : event.target?.parentElement;
      if (!el) return;
      selected=el; hovered=el; sourceTargets=[]; draw();
      const metrics=metricsFor(el,{x:event.clientX,y:event.clientY});
      const ownHTML=el.hasAttribute('data-hp-source')?el:null;
      const scriptId=!ownHTML&&typeof window.__hpScriptOwnerFor==='function'?window.__hpScriptOwnerFor(el):null;
      const source=ownHTML||el.closest(marker);
      if (scriptId!==null) parent.postMessage({hpInspect:session,type:'select',id:scriptId,kind:'script',metrics},'*');
      else if(source) parent.postMessage({hpInspect:session,type:'select',id:Number(source.getAttribute('data-hp-source')),approximate:source!==el,metrics},'*');
      else parent.postMessage({hpInspect:session,type:'miss',metrics},'*');
    },true);
    window.addEventListener('scroll',draw,true);
    window.addEventListener('resize',draw);
    // Keep existing drop relay for drag operations that enter the sandboxed preview.
    const hasFiles=event=>Array.from(event.dataTransfer?.types||[]).includes('Files');
    let lastDragSignal=0;
    function notifyFileDrag(event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect='copy';
      const now=Date.now();
      if (now-lastDragSignal>=160) {lastDragSignal=now;parent.postMessage({hpInspect:session,type:'file-drag'},'*');}
    }
    window.addEventListener('dragenter',notifyFileDrag,true);
    window.addEventListener('dragover',notifyFileDrag,true);
    window.addEventListener('drop',event=>{
      if (!hasFiles(event)) return;
      event.preventDefault();event.stopImmediatePropagation();
      const files=Array.from(event.dataTransfer?.files||[]).filter(file=>/\.html?$/i.test(file.name)&&file.size<=10*1024*1024).slice(0,24);
      Promise.all(files.map(async file=>({name:file.name,source:await file.text()})))
        .then(items=>parent.postMessage({hpInspect:session,type:'file-drop',files:items},'*'))
        .catch(()=>parent.postMessage({hpInspect:session,type:'file-drop-error'},'*'));
    },true);
    if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount,{once:true});
    else mount();
    parent.postMessage({hpInspect:session,type:'ready'},'*');
  }

