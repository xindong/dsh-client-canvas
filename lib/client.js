// DSH owns the view lifecycle; PixiBoardSDK's site owns ALL canvas UI/gestures.
window.__ModuleLoader__.load({
  id: '@miragari/dsh-client-canvas',
  factory: function(require) {
    var React = require('react');
    var createPortal = require('react-dom').createPortal;
    var conversationPhase = require('@deepseek-ai/dsh-client-ui-conversation').conversationPhase;
    var conversationMount = null;
    var mountListeners = new Set();
    function publishConversationMount(value) {
      conversationMount = value;
      mountListeners.forEach(function(listener) { listener(); });
    }
    function subscribeConversationMount(listener) {
      mountListeners.add(listener);
      return function() { mountListeners.delete(listener); };
    }
    function readConversationMount() { return conversationMount; }

    async function saveBeforeUnmount(packet) {
      if (!packet) return;
      var path = '/xindong-canvas/boards/' + encodeURIComponent(packet.boardId);
      // Fetch from the HOST realm: requests must survive the child iframe's
      // removal when the user changes conversation tabs.
      for (var attempt = 0; attempt < 4; attempt++) {
        var response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error('Final canvas read failed: ' + response.status);
        var latest = await response.json();
        var merged = packet.mergeDocuments(packet.baseline, packet.snapshot, latest.document, packet.rawBaseline);
        var saved = await fetch(path + '/replace', {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: latest.revision, document: merged })
        });
        if (saved.ok) return;
        if (saved.status !== 409) throw new Error('Final canvas save failed: ' + saved.status);
      }
      throw new Error('Final canvas save conflicted repeatedly');
    }

    async function sendNodeAgentPrompt(sessionId, text) {
      var mount = readConversationMount();
      if (!mount || mount.sessionId !== sessionId) throw new Error('当前对话尚未就绪，请稍后重试');
      await mount.reference.ready;
      if (readConversationMount() !== mount) throw new Error('当前对话已切换，请重新提交');
      var conversation = mount.reference.binding.ctx.get('conversation');
      if (!conversation) throw new Error('当前对话的发送服务不可用');
      await conversation.send(text);
    }

    function CanvasSurface(props) {
      var frame = React.useRef(null);
      var currentAgent = React.useRef(null);
      function closeAgent() {
        currentAgent.current = null;
        var child = frame.current && frame.current.contentWindow;
        if (child && child.__dshCanvasCloseNodeAgent) child.__dshCanvasCloseNodeAgent();
      }
      var modalState = React.useState(false);
      var modalOpen = modalState[0], setModalOpen = modalState[1];
      var loadingState = React.useState('loading');
      var loadState = loadingState[0], setLoadState = loadingState[1];
      function readLoadState() {
        var child = frame.current && frame.current.contentWindow;
        var state = child && child.__dshCanvasLoadState;
        if (state === 'ready' || state === 'error') setLoadState(state);
      }
      function retry() {
        setLoadState('loading');
        if (frame.current) frame.current.contentWindow.location.reload();
      }
      React.useLayoutEffect(function() {
        closeAgent();
        var child = frame.current && frame.current.contentWindow;
        var processedRequests = new Set();
        function onLoadState(event) {
          if (event.origin !== window.location.origin || event.source !== child) return;
          if (!event.data) return;
          if (event.data.type === 'dsh-canvas:settings-modal') { setModalOpen(event.data.open === true); return; }
          if (event.data.type === 'dsh-canvas:node-agent') {
            var message = event.data;
            if (message.action === 'close') { closeAgent(); return; }
            if (message.action === 'open' && message.node && message.boardId) {
              currentAgent.current = { boardId: message.boardId, nodeId: message.node.id, sessionId: props.sessionId };
            } else if (message.action === 'submit' && typeof message.requestId === 'string') {
              if (processedRequests.has(message.requestId)) return;
              processedRequests.add(message.requestId);
              var target = currentAgent.current;
              var context = message.context;
              var valid = target && target.sessionId === props.sessionId && context && context.node
                && context.boardId === target.boardId && context.node.id === target.nodeId
                && typeof message.instruction === 'string' && message.instruction.trim();
              Promise.resolve().then(function() {
                if (!valid || currentAgent.current !== target) throw new Error('当前节点或对话已切换，请重新提交');
                if (typeof message.prompt !== 'string' || !message.prompt.trim()) throw new Error('节点提示词尚未准备好，请重新提交');
                return props.sendPrompt(message.prompt);
              }).then(function() {
                child.postMessage({ type: 'dsh-canvas:node-agent-result', requestId: message.requestId, ok: true }, window.location.origin);
              }, function(error) {
                child.postMessage({ type: 'dsh-canvas:node-agent-result', requestId: message.requestId, ok: false,
                  error: error && typeof error.message === 'string' ? error.message : String(error) }, window.location.origin);
              });
            }
            return;
          }
          if (event.data.type !== 'dsh-canvas:load-state') return;
          var state = event.data.state;
          if (state === 'loading' || state === 'ready' || state === 'error') setLoadState(state);
          if (state === 'loading' || state === 'error') setModalOpen(false);
        }
        window.addEventListener('message', onLoadState);
        readLoadState();
        // The conversation tab unmounts inactive views. Notify the child
        // before teardown so the HTTP adapter can flush its last edit.
        return function() {
          window.removeEventListener('message', onLoadState);
          try {
            // Capture pan/zoom even while the site's async bootstrap is still
            // loading previews and its document bridge has not connected yet.
            if (child && child.__dshCanvasRememberViewport) child.__dshCanvasRememberViewport();
            if (child && child.__dshCanvasBeforeUnmount) {
              var packet = child.__dshCanvasBeforeUnmount();
              saveBeforeUnmount(packet).catch(function(error) {
                console.error('[dsh-canvas] final save failed', error);
              });
            } else if (child) child.dispatchEvent(new child.Event('pagehide'));
          } catch (error) { console.warn('[dsh-canvas] final save notification failed', error); }
        };
      }, [props.sessionId]);
      return React.createElement('div', {
        className: 'xindong-canvas-surface',
        'aria-busy': loadState === 'loading',
        style: {
          position: 'relative', display: 'flex', flexDirection: 'column', zIndex: modalOpen ? 3 : undefined,
          flex: '1 1 0', width: '100%', height: '100%',
          minWidth: 0, minHeight: 0, overflow: 'hidden'
        }
      }, React.createElement('iframe', {
        ref: frame,
        onLoad: readLoadState,
        src: '/xindong-canvas/site/',
        title: 'PixiBoard Canvas',
        allow: 'clipboard-read; clipboard-write; fullscreen',
        style: {
          display: 'block', flex: '1 1 0', width: '100%', height: '100%',
          minWidth: 0, minHeight: 0, border: 0
        }
      }), loadState !== 'ready' && React.createElement('div', {
        className: 'xindong-canvas-loading',
        role: loadState === 'error' ? 'alert' : 'status',
        'aria-live': 'polite'
      },
        loadState === 'loading' && React.createElement('svg', {
          className: 'xindong-canvas-loading-spinner', 'aria-hidden': true,
          viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none'
        },
          React.createElement('circle', { cx: 12, cy: 12, r: 10, stroke: 'currentColor', strokeWidth: 2, opacity: 0.18 }),
          React.createElement('circle', { cx: 12, cy: 12, r: 10, stroke: 'currentColor', strokeWidth: 2,
            strokeDasharray: '16 47', strokeLinecap: 'round' })
        ),
        React.createElement('span', null, loadState === 'error' ? '画布加载失败' : '正在加载画布…'),
        loadState === 'error' && React.createElement('button', {
          type: 'button', className: 'xindong-canvas-loading-retry', onClick: retry
        }, '重试')
      ));
    }

    // Render the native chat and composer together, inside one floating seat.
    // Forcing the chat view avoids nesting CanvasWorkspace through the view tab.
    function ChatViews(props) {
      return props.renderSlot('conversation.session', { view: 'chat' });
    }

    function FloatingConversation(props) {
      var session = props.useSession(function(value) { return value; });
      var conversation = props.useConversation(function(value) { return value; });
      var hero = conversationPhase(session, conversation) === 'blank';
      return props.renderFactorySlot('conversation.content', {
        variant: 'embedded', phase: hero ? 'hero' : 'active', hero: hero
      }, { slots: { views: ChatViews } });
    }

    // The additive shell seat has no conversation.content ancestor. Portal
    // its native conversation into this tab to avoid recursive factory calls.
    function ConversationPortal(props) {
      var mount = React.useSyncExternalStore(subscribeConversationMount, readConversationMount);
      if (!mount) return null;
      return createPortal(React.createElement(props.SessionProvider, { session: mount.reference },
        props.renderSlot('xindong.canvas.conversation', {})
      ), mount.container);
    }

    var workspaceCss = `
      .xindong-canvas-loading {
        position: absolute; inset: 0; z-index: 3;
        display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px;
        background: var(--dsw-alias-bg-base, #fff);
        color: var(--dsw-alias-label-secondary, #667085); font-size: 13px;
      }
      .xindong-canvas-loading-spinner {
        display: block; width: 22px; height: 22px; flex: none;
        border: 0; border-radius: 0; overflow: visible;
        color: var(--dsw-alias-brand-primary, #4f7cff);
        animation: xindong-canvas-loading-spin .8s linear infinite;
      }
      .xindong-canvas-loading-retry {
        padding: 5px 12px; border: 1px solid var(--dsw-alias-border-l3, #e5e7eb);
        border-radius: 6px; background: var(--dsw-alias-bg-base, #fff);
        color: var(--dsw-alias-brand-primary, #4f7cff); font: inherit; cursor: pointer;
      }
      .xindong-canvas-loading-retry:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff); outline-offset: 2px;
      }
      @keyframes xindong-canvas-loading-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) {
        .xindong-canvas-loading-spinner { animation: none; }
      }
      .xindong-canvas-workspace {
        position: relative; isolation: isolate; flex: 1 1 0;
        width: 100%; height: 100%; min-width: 0; min-height: 0;
        overflow: hidden; background: #f9fafc;
      }
      .xindong-canvas-workspace > .xindong-canvas-surface {
        position: absolute !important; inset: 0; z-index: auto;
      }
      .xindong-canvas-chat {
        box-sizing: border-box; position: absolute; z-index: 2; right: 16px; top: 16px; bottom: 16px;
        display: flex; flex-direction: column;
        width: min(var(--canvas-chat-width, 420px), 50%, calc(100% - 32px));
        height: calc(100% - 32px);
        max-height: calc(100% - 32px); min-height: 0;
        color: var(--dsw-alias-label-primary, #172033);
        background: var(--dsw-alias-bg-base, #fff);
        border: 1px solid var(--dsw-alias-border-l3, #d9e0ea);
        border-radius: 20px; overflow: hidden;
        box-shadow: 0 18px 64px rgba(25, 38, 58, .14), 0 2px 8px rgba(25, 38, 58, .05);
        --dsh-composer-side-clearance: 12px;
        --dsh-composer-card-max-width: 100%;
      }
      .xindong-canvas-chat[data-collapsed] {
        width: 44px; height: 44px; max-height: none; border-radius: 14px;
        bottom: auto;
        box-shadow: 0 4px 18px rgba(25, 38, 58, .12);
      }
      .xindong-canvas-chat[data-collapsed] .xindong-canvas-chat-handle,
      .xindong-canvas-chat[data-collapsed] .xindong-canvas-chat-resize { display: none; }
      .xindong-canvas-chat-launcher {
        display: grid; place-items: center; width: 100%; height: 100%; padding: 0;
        border: 0; background: transparent; color: inherit; cursor: grab; touch-action: none;
      }
      .xindong-canvas-chat-launcher:active { cursor: grabbing; }
      .xindong-canvas-chat-launcher:hover { background: var(--dsw-alias-bg-hover, #eef2f7); }
      .xindong-canvas-chat-launcher:focus-visible { outline: 2px solid #4f7cff; outline-offset: -3px; }
      .xindong-canvas-chat-launcher svg { display: block; flex: none; }

      .xindong-canvas-chat-handle {
        display: flex; align-items: center; justify-content: space-between;
        box-sizing: border-box; flex: none; height: 36px; padding: 3px 8px 3px 14px;
        border-bottom: 1px solid var(--dsw-alias-border-l3, #e8edf3);
        cursor: grab; touch-action: none; user-select: none;
      }
      .xindong-canvas-chat-handle:active { cursor: grabbing; }
      .xindong-canvas-chat-title { display: flex; flex: 1; min-width: 0; align-items: center; gap: 9px; font-size: 13px; font-weight: 600; }
      .xindong-canvas-chat-title-text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .xindong-canvas-chat-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: #4f7cff; }
      .xindong-canvas-chat-toggle {
        display: grid; place-items: center; flex: none; width: 28px; height: 28px;
        padding: 0; border: 0; border-radius: 8px; cursor: pointer;
        background: transparent; color: inherit; font-size: 18px;
      }
      .xindong-canvas-chat-toggle:hover { background: var(--dsw-alias-bg-hover, #eef2f7); }
      .xindong-canvas-chat-toggle:focus-visible { outline: 2px solid #4f7cff; outline-offset: 2px; }
      .xindong-canvas-chat-resize {
        position: absolute; z-index: 10; left: 0; top: 0; bottom: 0;
        width: 8px; cursor: ew-resize; touch-action: none;
      }
      .xindong-canvas-chat-resize::after {
        content: ''; position: absolute; left: 2px; top: calc(50% - 18px);
        width: 3px; height: 36px; border-radius: 3px;
        background: var(--dsw-alias-border-l3, #d9e0ea);
      }
      .xindong-canvas-chat-resize:hover::after,
      .xindong-canvas-chat-resize:focus-visible::after { background: #4f7cff; }
      .xindong-canvas-chat-resize:focus-visible { outline: 2px solid #4f7cff; outline-offset: -2px; }
      .xindong-canvas-chat-body { display: flex; flex: 1 1 0; flex-direction: column; min-height: 0; }
      .xindong-canvas-chat-body[hidden] { display: none; }
      /* Only the host of this Canvas tab yields its composer to the floating
         conversation. Other tabs and the embedded conversation keep theirs. */
      [data-conversation-scroll]:has(.xindong-canvas-workspace) > [data-composer-seat] { display: none; }
      [data-conversation-content]:has(.xindong-canvas-workspace) { overflow: hidden; }
      .xindong-canvas-chat-body > [data-conversation-content] { flex: 1 1 0; min-height: 0; width: 100%; }
      .xindong-canvas-chat [data-conversation-scroll] { min-height: 0; }
      /* Tighten only the transcript wrapper, leaving nested process groups intact. */
      .xindong-canvas-chat div:has(> [data-chat-flow=""]:not([data-step-process-content])) { padding: 8px 12px; }
      @media (max-width: 640px) {
        .xindong-canvas-chat { border-radius: 16px; }
      }
    `;

    function CanvasWorkspace(props) {
      var conversationTitle = props.useSessions(function(state) {
        var summary = state.byId[props.sessionId];
        return summary && summary.displayTitle ? summary.displayTitle : '新对话';
      });
      var root = React.useRef(null);
      var panel = React.useRef(null);
      var chatBody = React.useRef(null);
      var drag = React.useRef(null);
      var resize = React.useRef(null);
      var widthState = React.useState(420);
      var width = widthState[0], setWidth = widthState[1];
      var canvasWidthState = React.useState(840);
      var canvasWidth = canvasWidthState[0], setCanvasWidth = canvasWidthState[1];
      var maxWidth = Math.max(0, Math.min(canvasWidth / 2, canvasWidth - 32));
      var minWidth = Math.min(320, maxWidth);
      var effectiveWidth = Math.max(minWidth, Math.min(width, maxWidth));
      var collapsedState = React.useState(false);
      var collapsed = collapsedState[0], setCollapsed = collapsedState[1];
      var positionState = React.useState(null);
      var position = positionState[0], setPosition = positionState[1];
      var iconPositionState = React.useState(null);
      var iconPosition = iconPositionState[0], setIconPosition = iconPositionState[1];
      var iconDragged = React.useRef(false);
      React.useLayoutEffect(function() {
        var reference = props.retainSession(props.sessionId);
        var mount = { reference: reference, container: chatBody.current, sessionId: props.sessionId };
        publishConversationMount(mount);
        reference.ready.catch(function(error) { console.error('[dsh-canvas] chat session failed', error); });
        return function() {
          if (conversationMount === mount) publishConversationMount(null);
          reference.release();
        };
      }, [props.sessionId, props.retainSession]);

      React.useLayoutEffect(function() {
        var observer = new ResizeObserver(function() {
          if (root.current) setCanvasWidth(root.current.clientWidth);
          setIconPosition(function(current) {
            if (!current || !root.current) return current;
            var left = Math.max(0, Math.min(current.left, root.current.clientWidth - 44));
            var top = Math.max(0, Math.min(current.top, root.current.clientHeight - 44));
            return left === current.left && top === current.top ? current : { left: left, top: top };
          });
          setPosition(function(current) {
            if (!current || !root.current || !panel.current) return current;
            var left = Math.max(16, Math.min(current.left, root.current.clientWidth - panel.current.offsetWidth - 16));
            var top = Math.max(16, Math.min(current.top, root.current.clientHeight - panel.current.offsetHeight - 16));
            return left === current.left && top === current.top ? current : { left: left, top: top };
          });
        });
        if (root.current) observer.observe(root.current);
        if (panel.current) observer.observe(panel.current);
        return function() { observer.disconnect(); };
      }, []);

      function collapseAtButton(event) {
        var button = event.currentTarget.getBoundingClientRect();
        var parent = root.current.getBoundingClientRect();
        setIconPosition({
          left: Math.max(0, Math.min(button.left + button.width / 2 - parent.left - 22, root.current.clientWidth - 44)),
          top: Math.max(0, Math.min(button.top + button.height / 2 - parent.top - 22, root.current.clientHeight - 44))
        });
        setCollapsed(true);
      }
      function onIconPointerDown(event) {
        if (event.button !== 0) return;
        var bounds = panel.current.getBoundingClientRect();
        var parent = root.current.getBoundingClientRect();
        iconDragged.current = false;
        drag.current = { id: event.pointerId, icon: true, x: event.clientX, y: event.clientY,
          left: bounds.left - parent.left, top: bounds.top - parent.top };
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      function onPointerDown(event) {
        if (event.button !== 0 || event.target.closest('button')) return;
        var bounds = panel.current.getBoundingClientRect();
        var parent = root.current.getBoundingClientRect();
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY,
          left: bounds.left - parent.left, top: bounds.top - parent.top };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }
      function onPointerMove(event) {
        var start = drag.current;
        if (!start || start.id !== event.pointerId) return;
        if (start.icon) {
          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) iconDragged.current = true;
          if (!iconDragged.current) return;
          setIconPosition({
            left: Math.max(0, Math.min(start.left + event.clientX - start.x, root.current.clientWidth - 44)),
            top: Math.max(0, Math.min(start.top + event.clientY - start.y, root.current.clientHeight - 44))
          });
          return;
        }
        setPosition({
          left: Math.max(16, Math.min(start.left + event.clientX - start.x,
            root.current.clientWidth - panel.current.offsetWidth - 16)),
          top: Math.max(16, Math.min(start.top + event.clientY - start.y,
            root.current.clientHeight - panel.current.offsetHeight - 16))
        });
      }
      function onPointerEnd(event) {
        if (!drag.current || drag.current.id !== event.pointerId) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }

      function changeWidth(nextWidth, rightEdge) {
        var available = root.current.clientWidth;
        var maximum = Math.max(0, Math.min(available / 2, available - 32));
        var next = Math.max(Math.min(320, maximum), Math.min(nextWidth, maximum));
        setWidth(next);
        setPosition(function(current) {
          if (!current) return current;
          var right = rightEdge === undefined ? current.left + panel.current.offsetWidth : rightEdge;
          return { left: Math.max(16, Math.min(right - next, available - next - 16)), top: current.top };
        });
      }
      function onResizeStart(event) {
        if (event.button !== 0) return;
        var bounds = panel.current.getBoundingClientRect();
        var parent = root.current.getBoundingClientRect();
        resize.current = { id: event.pointerId, x: event.clientX, width: bounds.width, right: bounds.right - parent.left };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      }
      function onResizeMove(event) {
        var start = resize.current;
        if (!start || start.id !== event.pointerId) return;
        changeWidth(start.width + start.x - event.clientX, start.right);
      }
      function onResizeEnd(event) {
        if (!resize.current || resize.current.id !== event.pointerId) return;
        resize.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }
      function onResizeKey(event) {
        var next;
        if (event.key === 'ArrowLeft') next = effectiveWidth + 16;
        else if (event.key === 'ArrowRight') next = effectiveWidth - 16;
        else if (event.key === 'Home') next = minWidth;
        else if (event.key === 'End') next = maxWidth;
        else return;
        event.preventDefault();
        changeWidth(next);
      }

      return React.createElement('div', { ref: root, className: 'xindong-canvas-workspace', 'data-conversation-composer-overlay': '' },
        React.createElement('style', null, workspaceCss),
        React.createElement(CanvasSurface, { sessionId: props.sessionId, sendPrompt: function(text) { return sendNodeAgentPrompt(props.sessionId, text); } }),
        React.createElement('section', {
          ref: panel, className: 'xindong-canvas-chat', 'aria-label': '画布 AI 对话',
          'data-collapsed': collapsed ? '' : undefined,
          style: Object.assign({ '--canvas-chat-width': effectiveWidth + 'px' },
            (collapsed ? iconPosition : position) ? { left: (collapsed ? iconPosition : position).left,
              top: (collapsed ? iconPosition : position).top, right: 'auto', bottom: 'auto' } : {})
        },
          collapsed && React.createElement('button', {
            type: 'button', className: 'xindong-canvas-chat-launcher',
            'aria-label': '展开对话', 'aria-expanded': false, title: '展开对话',
            onPointerDown: onIconPointerDown, onPointerMove: onPointerMove,
            onPointerUp: onPointerEnd, onPointerCancel: function(event) { iconDragged.current = true; onPointerEnd(event); },
            onClick: function(event) { if (event.detail === 0 || !iconDragged.current) setCollapsed(false); }
          }, React.createElement('svg', {
            width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
            'aria-hidden': true
          }, React.createElement('path', { d: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z' }))),
          React.createElement('div', {
            className: 'xindong-canvas-chat-handle', onPointerDown: onPointerDown,
            onPointerMove: onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd
          },
            React.createElement('span', { className: 'xindong-canvas-chat-title' },
              React.createElement('span', { className: 'xindong-canvas-chat-dot', 'aria-hidden': true }),
              React.createElement('span', { className: 'xindong-canvas-chat-title-text', title: conversationTitle }, conversationTitle)),
            React.createElement('button', {
              type: 'button', className: 'xindong-canvas-chat-toggle',
              'aria-label': collapsed ? '展开对话' : '收起对话', 'aria-expanded': !collapsed,
              title: collapsed ? '展开对话' : '收起对话',
              onClick: collapseAtButton
            }, collapsed ? '+' : '−')
          ),
          React.createElement('div', { ref: chatBody, className: 'xindong-canvas-chat-body', hidden: collapsed }),
          React.createElement('div', {
            className: 'xindong-canvas-chat-resize', role: 'separator', tabIndex: 0,
            'aria-label': '调整对话框宽度', 'aria-orientation': 'vertical',
            'aria-valuemin': Math.round(minWidth), 'aria-valuemax': Math.round(maxWidth),
            'aria-valuenow': Math.round(effectiveWidth), title: '拖动调整宽度',
            onPointerDown: onResizeStart, onPointerMove: onResizeMove,
            onPointerUp: onResizeEnd, onPointerCancel: onResizeEnd, onKeyDown: onResizeKey
          })
        )
      );
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'conversation'],
      apply: function(ctx) {
        ctx.effect(function() {
          return ctx.locale.register('canvas', {
            zh: { 'view.canvas': '画布' }, en: { 'view.canvas': 'Canvas' }
          });
        }, 'xindong-client-canvas: locale');
        var t = ctx.locale.bind('canvas');
        // Extend the view roster; DSH retains its sidebar, header and tab shell.
        ctx.slots.inject('conversation.view', function() {
          return ctx.slots.register({
            name: 'conversation.view', id: 'canvas', order: 25,
            label: function() { return t('view.canvas'); },
            inject: function() { return {
              retainSession: function(sessionId) { return ctx.sessions.retain(sessionId, { source: 'canvasChat' }); }
            }; }
          }, CanvasWorkspace);
        });
        ctx.slots.inject('shell.overlay', function() {
          return ctx.slots.register({
            name: 'shell.overlay', id: 'xindong-canvas-chat',
            children: { 'xindong.canvas.conversation': { kind: 'single', scope: 'session' } }
          }, ConversationPortal);
        });
        ctx.slots.inject('xindong.canvas.conversation', function() {
          return ctx.slots.register({ name: 'xindong.canvas.conversation' }, FloatingConversation);
        });
      }
    };
  }
});
