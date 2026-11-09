const fs = require('fs');
const path = require('path');

// Key name → { key, code, keyCode (Windows virtual key code) }
const KEY_MAP = {
  Enter:      { key: 'Enter',      code: 'Enter',        keyCode: 13 },
  Tab:        { key: 'Tab',        code: 'Tab',          keyCode: 9  },
  Escape:     { key: 'Escape',     code: 'Escape',       keyCode: 27 },
  Backspace:  { key: 'Backspace',  code: 'Backspace',    keyCode: 8  },
  Delete:     { key: 'Delete',     code: 'Delete',       keyCode: 46 },
  ArrowUp:    { key: 'ArrowUp',    code: 'ArrowUp',      keyCode: 38 },
  ArrowDown:  { key: 'ArrowDown',  code: 'ArrowDown',    keyCode: 40 },
  ArrowLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',    keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight',   keyCode: 39 },
  Home:       { key: 'Home',       code: 'Home',         keyCode: 36 },
  End:        { key: 'End',        code: 'End',          keyCode: 35 },
  PageUp:     { key: 'PageUp',     code: 'PageUp',       keyCode: 33 },
  PageDown:   { key: 'PageDown',   code: 'PageDown',     keyCode: 34 },
  Space:      { key: ' ',          code: 'Space',        keyCode: 32 },
  F1:         { key: 'F1',         code: 'F1',           keyCode: 112 },
  F2:         { key: 'F2',         code: 'F2',           keyCode: 113 },
  F3:         { key: 'F3',         code: 'F3',           keyCode: 114 },
  F4:         { key: 'F4',         code: 'F4',           keyCode: 115 },
  F5:         { key: 'F5',         code: 'F5',           keyCode: 116 },
  F6:         { key: 'F6',         code: 'F6',           keyCode: 117 },
  F7:         { key: 'F7',         code: 'F7',           keyCode: 118 },
  F8:         { key: 'F8',         code: 'F8',           keyCode: 119 },
  F9:         { key: 'F9',         code: 'F9',           keyCode: 120 },
  F10:        { key: 'F10',        code: 'F10',          keyCode: 121 },
  F11:        { key: 'F11',        code: 'F11',          keyCode: 122 },
  F12:        { key: 'F12',        code: 'F12',          keyCode: 123 }
};

class InteractionManager {
  constructor(webContents, basePath) {
    this.webContents = webContents;
    this.basePath = basePath; // project root for reading templates
    this.pickerActive = false;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  async _sendCDP(method, params = {}) {
    try {
      return await this.webContents.debugger.sendCommand(method, params);
    } catch (err) {
      throw new Error(`CDP ${method} failed: ${err.message}`);
    }
  }

  async _resolveTarget(target) {
    if (target && target.selector) {
      const resolved = await this.resolveSelector(target.selector);
      if (!resolved.success) {
        return { success: false, error: resolved.error };
      }
      return { success: true, x: resolved.centerX, y: resolved.centerY, tagName: resolved.tagName, text: resolved.text, selector: target.selector };
    }
    if (target && typeof target.x === 'number' && typeof target.y === 'number') {
      return { success: true, x: target.x, y: target.y };
    }
    return { success: false, error: 'Target must have {selector} or {x, y}' };
  }

  // ── Core Interaction Methods ─────────────────────────────────────────

  async resolveSelector(selector) {
    try {
      const { result, exceptionDetails } = await this._sendCDP('Runtime.evaluate', {
        expression: `
          (function() {
            var el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return JSON.stringify({ exists: false });
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            var rect = el.getBoundingClientRect();
            return JSON.stringify({
              exists: true,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              centerX: rect.x + rect.width / 2,
              centerY: rect.y + rect.height / 2,
              tagName: el.tagName.toLowerCase(),
              text: (el.textContent || '').trim().substring(0, 200)
            });
          })()
        `,
        returnByValue: true
      });

      if (exceptionDetails) {
        return { success: false, error: exceptionDetails.text || 'Evaluation error' };
      }

      const data = JSON.parse(result.value);
      if (!data.exists) {
        return { success: false, error: `Element not found: ${selector}` };
      }
      return { success: true, ...data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async click(target) {
    try {
      const resolved = await this._resolveTarget(target);
      if (!resolved.success) return resolved;

      const { x, y } = resolved;

      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y
      });
      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1
      });
      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1
      });

      return {
        success: true, x, y,
        selector: resolved.selector,
        tagName: resolved.tagName,
        text: resolved.text
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async dblclick(target) {
    try {
      const resolved = await this._resolveTarget(target);
      if (!resolved.success) return resolved;

      const { x, y } = resolved;

      // First click
      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y
      });
      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1
      });
      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1
      });

      // Second click (clickCount: 2)
      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 2
      });
      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 2
      });

      return {
        success: true, x, y,
        selector: resolved.selector,
        tagName: resolved.tagName,
        text: resolved.text
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async rightclick(target) {
    try {
      const resolved = await this._resolveTarget(target);
      if (!resolved.success) return resolved;

      const { x, y } = resolved;

      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y
      });
      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'right', clickCount: 1
      });
      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'right', clickCount: 1
      });

      return {
        success: true, x, y,
        selector: resolved.selector,
        tagName: resolved.tagName,
        text: resolved.text
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async hover(target) {
    try {
      const resolved = await this._resolveTarget(target);
      if (!resolved.success) return resolved;

      const { x, y } = resolved;

      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y
      });

      return {
        success: true, x, y,
        selector: resolved.selector,
        tagName: resolved.tagName,
        text: resolved.text
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async type(target) {
    try {
      // Click to focus if selector is given
      if (target && target.selector) {
        const clickResult = await this.click({ selector: target.selector });
        if (!clickResult.success) return clickResult;
      }

      const text = target.text || '';

      // Use Input.insertText for the whole string
      await this._sendCDP('Input.insertText', { text });

      return { success: true, text, selector: target.selector };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async pressKey(key) {
    try {
      const mapped = KEY_MAP[key];
      if (!mapped) {
        return { success: false, error: `Unknown key: ${key}` };
      }

      await this._sendCDP('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: mapped.key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.keyCode,
        nativeVirtualKeyCode: mapped.keyCode
      });
      await this._sendCDP('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: mapped.key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.keyCode,
        nativeVirtualKeyCode: mapped.keyCode
      });

      return { success: true, key };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async scroll(target) {
    try {
      let x = 0;
      let y = 0;

      if (target && target.selector) {
        const resolved = await this._resolveTarget({ selector: target.selector });
        if (!resolved.success) return resolved;
        x = resolved.x;
        y = resolved.y;
      } else if (target && typeof target.x === 'number' && typeof target.y === 'number') {
        x = target.x;
        y = target.y;
      }

      const deltaX = target.deltaX || 0;
      const deltaY = target.deltaY || 0;

      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX, deltaY
      });

      return { success: true, x, y, deltaX, deltaY };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async getElementInfo(selector) {
    try {
      const { result, exceptionDetails } = await this._sendCDP('Runtime.evaluate', {
        expression: `
          (function() {
            var el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return JSON.stringify({ exists: false });
            var rect = el.getBoundingClientRect();
            var style = window.getComputedStyle(el);
            var attrs = {};
            for (var i = 0; i < el.attributes.length; i++) {
              attrs[el.attributes[i].name] = el.attributes[i].value;
            }
            // Build a computed selector
            var computedSelector = el.tagName.toLowerCase();
            if (el.id) computedSelector += '#' + el.id;
            if (el.className && typeof el.className === 'string') {
              computedSelector += '.' + el.className.trim().split(/\\s+/).join('.');
            }
            return JSON.stringify({
              exists: true,
              tagName: el.tagName.toLowerCase(),
              id: el.id || '',
              className: (typeof el.className === 'string' ? el.className : '') || '',
              textContent: (el.textContent || '').trim().substring(0, 500),
              href: el.href || '',
              value: el.value !== undefined ? el.value : '',
              type: el.type || '',
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              computedSelector: computedSelector,
              isVisible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0,
              attributes: attrs
            });
          })()
        `,
        returnByValue: true
      });

      if (exceptionDetails) {
        return { success: false, error: exceptionDetails.text || 'Evaluation error' };
      }

      const data = JSON.parse(result.value);
      return { success: data.exists, ...data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async waitForElement(selector, timeout = 5000) {
    const interval = 200;
    const maxAttempts = Math.ceil(timeout / interval);

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const { result } = await this._sendCDP('Runtime.evaluate', {
          expression: `!!document.querySelector(${JSON.stringify(selector)})`,
          returnByValue: true
        });

        if (result.value === true) {
          return { success: true, selector, attempts: i + 1 };
        }
      } catch (err) {
        // keep polling
      }

      await new Promise(resolve => setTimeout(resolve, interval));
    }

    return { success: false, error: `Timeout waiting for element: ${selector}`, timeout };
  }

  async evaluate(expression) {
    try {
      const { result, exceptionDetails } = await this._sendCDP('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });

      if (exceptionDetails) {
        return { success: false, error: exceptionDetails.text || exceptionDetails.exception?.description || 'Evaluation error' };
      }

      return { success: true, value: result.value };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async setValue(selector, value) {
    try {
      // Click to focus
      const clickResult = await this.click({ selector });
      if (!clickResult.success) return clickResult;

      // Clear and set value via JS
      const { exceptionDetails } = await this._sendCDP('Runtime.evaluate', {
        expression: `
          (function() {
            var el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.focus();
            el.value = '';
            el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()
        `,
        returnByValue: true
      });

      if (exceptionDetails) {
        return { success: false, error: exceptionDetails.text || 'Evaluation error' };
      }

      return { success: true, selector, value };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async selectOption(selector, value) {
    try {
      const { result, exceptionDetails } = await this._sendCDP('Runtime.evaluate', {
        expression: `
          (function() {
            var el = document.querySelector(${JSON.stringify(selector)});
            if (!el || el.tagName.toLowerCase() !== 'select') return JSON.stringify({ success: false, error: 'Element is not a <select>' });
            el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return JSON.stringify({ success: true, value: el.value });
          })()
        `,
        returnByValue: true
      });

      if (exceptionDetails) {
        return { success: false, error: exceptionDetails.text || 'Evaluation error' };
      }

      const data = JSON.parse(result.value);
      return { ...data, selector };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async getAttribute(selector, attribute) {
    try {
      const { result, exceptionDetails } = await this._sendCDP('Runtime.evaluate', {
        expression: `
          (function() {
            var el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return JSON.stringify({ exists: false });
            return JSON.stringify({ exists: true, value: el.getAttribute(${JSON.stringify(attribute)}) });
          })()
        `,
        returnByValue: true
      });

      if (exceptionDetails) {
        return { success: false, error: exceptionDetails.text || 'Evaluation error' };
      }

      const data = JSON.parse(result.value);
      if (!data.exists) {
        return { success: false, error: `Element not found: ${selector}` };
      }

      return { success: true, selector, attribute, value: data.value };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── Picker Methods ───────────────────────────────────────────────────

  async startPicker() {
    try {
      const scriptPath = path.join(this.basePath, 'templates', 'picker-overlay.js');
      const script = fs.readFileSync(scriptPath, 'utf-8');

      await this._sendCDP('Runtime.evaluate', {
        expression: script,
        returnByValue: true
      });

      this.pickerActive = true;
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async stopPicker() {
    try {
      await this._sendCDP('Runtime.evaluate', {
        expression: `
          (function() {
            if (typeof window.__autoBrowserPickerCleanup === 'function') {
              window.__autoBrowserPickerCleanup();
            }
          })()
        `,
        returnByValue: true
      });

      this.pickerActive = false;
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = InteractionManager;
