(function() {
  if (window.__autoBrowserActionRecorderInstalled) return;
  window.__autoBrowserActionRecorderInstalled = true;

  var INPUT_DEBOUNCE_MS = 400;
  var SCROLL_DEBOUNCE_MS = 500;
  var SCROLL_MIN_DELTA = 50;

  var ATTR_ALLOWLIST = [
    'name', 'type', 'placeholder', 'ng-click', 'ng-model', 'ng-change',
    'href', 'role', 'aria-label', 'data-testid', 'data-test', 'data-cy',
    'title', 'alt', 'for', 'formaction'
  ];

  var IGNORED_CLASS_RE = /^(ng-|active$|hover$|focus$|selected$|open$|show$|disabled$|is-|has-)/;

  var pendingInputs = new Map();       // Element -> { timer, element }
  var lastEmittedInput = new WeakMap(); // Element -> string
  var pendingScrollTimer = null;
  var lastScrollPos = new WeakMap();   // Element/Document -> { x, y }

  function isPickerElement(el) {
    if (!el || el.nodeType !== 1) return false;
    return el.id === '__ab-picker-overlay' || el.id === '__ab-picker-tooltip' ||
      !!(el.closest && (el.closest('#__ab-picker-overlay') || el.closest('#__ab-picker-tooltip')));
  }

  function shouldIgnoreEvent(target) {
    if (window.__autoBrowserPickerActive) return true;
    if (isPickerElement(target)) return true;
    return false;
  }

  function safeEscapeCss(str) {
    if (typeof CSS !== 'undefined' && CSS.escape) {
      return CSS.escape(str);
    }
    return String(str).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }

  function safeAttrVal(val) {
    return String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function isUniqueSelector(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }

  function resolveInteractiveTarget(el) {
    if (!el || el.nodeType !== 1) return el;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) {
      return el;
    }
    if (el.closest) {
      var interactive = el.closest(
        'button, a, [role="button"], [role="menuitem"], [role="option"], [role="tab"], ' +
        '[role="link"], [role="checkbox"], [role="radio"], [ng-click], [onclick], [data-action]'
      );
      if (interactive) return interactive;
    }
    return el;
  }

  function generateCssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    var curr = el;
    while (curr && curr.nodeType === 1 && curr !== document.documentElement) {
      if (curr.id && isUniqueSelector('#' + safeEscapeCss(curr.id))) {
        parts.unshift('#' + safeEscapeCss(curr.id));
        break;
      }
      var tag = curr.tagName.toLowerCase();
      var idx = 1;
      var sib = curr.previousElementSibling;
      while (sib) {
        idx++;
        sib = sib.previousElementSibling;
      }
      if (curr === document.body) {
        parts.unshift('body');
        break;
      }
      parts.unshift(tag + ':nth-child(' + idx + ')');
      curr = curr.parentElement;
    }
    return parts.join(' > ');
  }

  function generateSmartSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    var tag = el.tagName.toLowerCase();

    // 1. Unique ID
    if (el.id) {
      var idSel = '#' + safeEscapeCss(el.id);
      if (isUniqueSelector(idSel)) return idSel;
    }

    // 2. Unique semantic / framework attribute
    var priorityAttrs = [
      'data-testid', 'data-test', 'data-cy',
      'ng-click', 'ng-model', 'name',
      'aria-label', 'placeholder', 'title'
    ];
    for (var i = 0; i < priorityAttrs.length; i++) {
      var attr = priorityAttrs[i];
      var val = el.getAttribute && el.getAttribute(attr);
      if (val && val.length <= 120) {
        var attrSel = tag + '[' + attr + '="' + safeAttrVal(val) + '"]';
        if (isUniqueSelector(attrSel)) return attrSel;
      }
    }

    // 3. Unique tag + href for short links
    if (tag === 'a') {
      var href = el.getAttribute && el.getAttribute('href');
      if (href && href.length <= 120 && href !== '#' && href.indexOf('javascript:') !== 0) {
        var hrefSel = 'a[href="' + safeAttrVal(href) + '"]';
        if (isUniqueSelector(hrefSel)) return hrefSel;
      }
    }

    // 4. Tag + meaningful classes
    if (el.className && typeof el.className === 'string') {
      var stableClasses = el.className.trim().split(/\s+/).filter(function(c) {
        return c && !IGNORED_CLASS_RE.test(c);
      }).slice(0, 3);
      if (stableClasses.length > 0) {
        var clsSel = tag + '.' + stableClasses.map(safeEscapeCss).join('.');
        if (isUniqueSelector(clsSel)) return clsSel;
      }
    }

    // 5. Fallback structural CSS path
    return generateCssPath(el);
  }

  function generateXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    var curr = el;
    while (curr && curr.nodeType === 1) {
      var tag = curr.tagName.toLowerCase();
      var idx = 1;
      var sib = curr.previousSibling;
      while (sib) {
        if (sib.nodeType === 1 && sib.tagName.toLowerCase() === tag) idx++;
        sib = sib.previousSibling;
      }
      parts.unshift(tag + '[' + idx + ']');
      curr = curr.parentNode;
    }
    return '/' + parts.join('/');
  }

  function extractAttributes(el) {
    var attrs = {};
    if (!el || !el.getAttribute) return attrs;
    for (var i = 0; i < ATTR_ALLOWLIST.length; i++) {
      var key = ATTR_ALLOWLIST[i];
      var val = el.getAttribute(key);
      if (val !== null && val !== '') {
        attrs[key] = String(val).substring(0, 200);
      }
    }
    return attrs;
  }

  function getElementValue(el) {
    if (!el) return null;
    if (el.isContentEditable) {
      return (el.innerText || el.textContent || '').trim().substring(0, 1000);
    }
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.type === 'file') return null;
      return el.value !== undefined ? String(el.value).substring(0, 1000) : null;
    }
    return null;
  }

  function buildTargetInfo(el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = el.tagName.toLowerCase();
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    var textSource = el.innerText || el.textContent || '';
    var cleanText = textSource.replace(/\s+/g, ' ').trim().substring(0, 200);
    var isPassword = tag === 'input' && (el.type || '').toLowerCase() === 'password';

    var info = {
      tagName: tag,
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className.trim() : '',
      selector: generateSmartSelector(el),
      cssPath: generateCssPath(el),
      xpath: generateXPath(el),
      text: cleanText,
      value: getElementValue(el),
      checked: (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) ? !!el.checked : null,
      selectedText: (tag === 'select' && el.selectedIndex >= 0 && el.options[el.selectedIndex])
        ? (el.options[el.selectedIndex].text || '').trim().substring(0, 200)
        : null,
      isContentEditable: !!el.isContentEditable,
      isPassword: isPassword,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      attributes: extractAttributes(el)
    };
    return info;
  }

  function emitAction(actionType, el, coordinates, meta) {
    try {
      var payload = {
        timestamp: Date.now(),
        wallTime: new Date().toISOString(),
        action: actionType,
        url: window.location.href,
        pageTitle: document.title || '',
        isTopFrame: window.top === window,
        target: el ? buildTargetInfo(el) : null,
        coordinates: coordinates || null,
        meta: meta || {}
      };
      var serialized = JSON.stringify(payload);
      if (typeof window.__abRecordAction === 'function') {
        window.__abRecordAction(serialized);
      } else {
        console.debug('__AB_ACTION__:' + serialized);
      }
    } catch (err) {}
  }

  function flushInputForElement(el) {
    if (!el) return;
    var entry = pendingInputs.get(el);
    if (entry) {
      clearTimeout(entry.timer);
      pendingInputs.delete(el);
    }
    var val = getElementValue(el);
    if (val === null) return;
    if (lastEmittedInput.get(el) === val) return;
    lastEmittedInput.set(el, val);
    emitAction('input', el, null, { inputType: el.type || (el.isContentEditable ? 'contenteditable' : 'text') });
  }

  function flushAllPendingInputs(exceptEl) {
    pendingInputs.forEach(function(entry, el) {
      if (!exceptEl || el !== exceptEl) {
        flushInputForElement(el);
      }
    });
  }

  function onClick(e) {
    if (shouldIgnoreEvent(e.target)) return;
    if (!e.isTrusted && e.detail === 0 && !e.pointerType) {
      // Allow both user clicks and programmatic interaction clicks, only skip synthetic zero-coord noise unless button click
    }
    var target = resolveInteractiveTarget(e.target);
    flushAllPendingInputs(target);

    var coords = {
      clientX: Math.round(e.clientX || 0),
      clientY: Math.round(e.clientY || 0),
      pageX: Math.round(e.pageX || 0),
      pageY: Math.round(e.pageY || 0)
    };
    emitAction('click', target, coords, {
      button: typeof e.button === 'number' ? e.button : 0,
      detail: e.detail || 1,
      rawTagName: e.target && e.target.tagName ? e.target.tagName.toLowerCase() : ''
    });
  }

  function onDblClick(e) {
    if (shouldIgnoreEvent(e.target)) return;
    var target = resolveInteractiveTarget(e.target);
    var coords = {
      clientX: Math.round(e.clientX || 0),
      clientY: Math.round(e.clientY || 0),
      pageX: Math.round(e.pageX || 0),
      pageY: Math.round(e.pageY || 0)
    };
    emitAction('dblclick', target, coords, { button: typeof e.button === 'number' ? e.button : 0 });
  }

  function onInput(e) {
    var el = e.target;
    if (shouldIgnoreEvent(el)) return;
    if (!el || el.nodeType !== 1) return;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file')) {
      return; // Handled cleanly by change event
    }
    if (tag === 'select') return;

    var existing = pendingInputs.get(el);
    if (existing) clearTimeout(existing.timer);
    var timer = setTimeout(function() {
      flushInputForElement(el);
    }, INPUT_DEBOUNCE_MS);
    pendingInputs.set(el, { timer: timer, element: el });
  }

  function onChange(e) {
    var el = e.target;
    if (shouldIgnoreEvent(el)) return;
    if (!el || el.nodeType !== 1) return;
    var tag = el.tagName.toLowerCase();

    if (tag === 'select') {
      flushAllPendingInputs(el);
      emitAction('select', el, null, { selectedIndex: el.selectedIndex });
      return;
    }
    if (tag === 'input') {
      var type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox') {
        flushAllPendingInputs(el);
        emitAction('check', el, null, { checked: !!el.checked });
        return;
      }
      if (type === 'radio') {
        flushAllPendingInputs(el);
        emitAction('radio', el, null, { checked: !!el.checked });
        return;
      }
      if (type === 'file') {
        flushAllPendingInputs(el);
        var files = [];
        if (el.files) {
          for (var i = 0; i < el.files.length; i++) {
            files.push({ name: el.files[i].name, size: el.files[i].size, type: el.files[i].type });
          }
        }
        emitAction('file_select', el, null, { files: files });
        return;
      }
    }
    flushInputForElement(el);
  }

  function onBlur(e) {
    var el = e.target;
    if (el && pendingInputs.has(el)) {
      flushInputForElement(el);
    }
  }

  function onKeyDown(e) {
    if (shouldIgnoreEvent(e.target)) return;
    var key = e.key;
    if (!key) return;

    var isActionKey = (
      key === 'Enter' || key === 'Tab' || key === 'Escape' ||
      key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
    );
    var isShortcut = (e.ctrlKey || e.metaKey || e.altKey) &&
      key !== 'Control' && key !== 'Shift' && key !== 'Alt' && key !== 'Meta';

    if (!isActionKey && !isShortcut) return;

    if (key === 'Enter' || key === 'Tab') {
      flushInputForElement(e.target);
    }

    emitAction('keydown', e.target && e.target.nodeType === 1 ? e.target : document.body, null, {
      key: key,
      code: e.code || '',
      ctrlKey: !!e.ctrlKey,
      shiftKey: !!e.shiftKey,
      altKey: !!e.altKey,
      metaKey: !!e.metaKey
    });
  }

  function onSubmit(e) {
    if (shouldIgnoreEvent(e.target)) return;
    flushAllPendingInputs();
    var form = e.target;
    emitAction('submit', form && form.nodeType === 1 ? form : null, null, {
      actionUrl: form && form.action ? form.action : '',
      method: form && form.method ? form.method.toUpperCase() : 'GET'
    });
  }

  function onScroll(e) {
    if (window.__autoBrowserPickerActive) return;
    var scrollTarget = (e.target === document || e.target === document.documentElement || e.target === document.body)
      ? document
      : e.target;

    if (pendingScrollTimer) clearTimeout(pendingScrollTimer);
    pendingScrollTimer = setTimeout(function() {
      pendingScrollTimer = null;
      var x = scrollTarget === document ? (window.scrollX || window.pageXOffset || 0) : (scrollTarget.scrollLeft || 0);
      var y = scrollTarget === document ? (window.scrollY || window.pageYOffset || 0) : (scrollTarget.scrollTop || 0);
      var prev = lastScrollPos.get(scrollTarget) || { x: 0, y: 0 };

      if (Math.abs(x - prev.x) < SCROLL_MIN_DELTA && Math.abs(y - prev.y) < SCROLL_MIN_DELTA) {
        return;
      }
      lastScrollPos.set(scrollTarget, { x: x, y: y });

      var targetEl = scrollTarget === document ? document.documentElement : scrollTarget;
      emitAction('scroll', targetEl, null, {
        scrollX: Math.round(x),
        scrollY: Math.round(y),
        deltaX: Math.round(x - prev.x),
        deltaY: Math.round(y - prev.y)
      });
    }, SCROLL_DEBOUNCE_MS);
  }

  function onPageHide() {
    flushAllPendingInputs();
  }

  document.addEventListener('click', onClick, true);
  document.addEventListener('dblclick', onDblClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('blur', onBlur, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('pagehide', onPageHide, true);
})();

