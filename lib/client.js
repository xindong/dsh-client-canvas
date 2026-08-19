window.__ModuleLoader__.load({
  id: '@xindong/dsh-client-canvas',
  factory: function(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useState = React.useState;
    var useCallback = React.useCallback;

    var NS = 'canvas';
    var zh = { 'view.canvas': '画布' };
    var en = { 'view.canvas': 'Canvas' };

    exports.inject = ['slots', 'locale'];
    exports.apply = function apply(ctx) {
      if (ctx.locale && ctx.locale.register) {
        ctx.effect(function() { return ctx.locale.register(NS, { zh: zh, en: en }); }, 'xindong-client-canvas: locale');
      }
      var t = ctx.locale ? ctx.locale.bind(NS) : function(k) { return k === 'view.canvas' ? 'Canvas' : k; };

      ctx.slots.inject('conversation.view', function() {
        return ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'canvas',
            order: 25,
            label: function() { return t('view.canvas'); }
          },
          CanvasViewApp
        );
      });
    };

    function CanvasViewApp(props) {
      var sessionId = props.sessionId || (props.session && props.session.id) || 'default';
      var containerRef = useRef(null);
      var boardRef = useRef(null);
      var appRef = useRef(null);
      var docState = useState(null);
      var doc = docState[0];
      var setDoc = docState[1];
      var statusState = useState('connecting');
      var status = statusState[0];
      var setStatus = statusState[1];
      var localRevRef = useRef(0);
      var syncingRef = useRef(false);

      var fetchDoc = useCallback(function() {
        return fetch('/xindong-canvas/boards/' + encodeURIComponent(sessionId))
          .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function(data) {
            setDoc(data.document);
            localRevRef.current = data.revision;
            setStatus('connected');
            return data.document;
          })
          .catch(function(e) {
            setStatus('error');
            console.error('[dsh-canvas] fetch error:', e);
            return null;
          });
      }, [sessionId]);

      useEffect(function() {
        fetchDoc();
        var timer = setInterval(function() {
          if (syncingRef.current) return;
          fetch('/xindong-canvas/boards/' + encodeURIComponent(sessionId))
            .then(function(res) { return res.ok ? res.json() : null; })
            .then(function(data) {
              if (data && data.revision > localRevRef.current) {
                localRevRef.current = data.revision;
                setDoc(data.document);
                if (boardRef.current) {
                  syncingRef.current = true;
                  boardRef.current.document.load(data.document).finally(function() {
                    syncingRef.current = false;
                  });
                }
              }
            })
            .catch(function() {});
        }, 1500);
        return function() { clearInterval(timer); };
      }, [sessionId, fetchDoc]);

      useEffect(function() {
        var destroyed = false;
        var instance = null;

        if (!containerRef.current) return;

        import('/xindong-canvas/pixiboard.js')
          .then(function(mod) {
            if (destroyed) return;
            var createPixiBoard = mod.createPixiBoard;
            var PixiBoardRenderer = mod.PixiBoardRenderer;

            var initialDoc = doc || {
              schemaVersion: 1,
              revision: localRevRef.current,
              nodes: [],
              assets: [],
              viewport: { scale: 1, offset: { x: 0, y: 0 } }
            };

            var application = null;
            return createPixiBoard({
              container: containerRef.current,
              document: initialDoc,
              interactions: { pointer: true, keyboard: true },
              rendererFactory: function(options) {
                return new PixiBoardRenderer(Object.assign({}, options, {
                  applicationFactory: function() {
                    return import('pixi.js').then(function(pixi) {
                      var app = new pixi.Application();
                      return Promise.resolve(app.init({
                        resizeTo: containerRef.current,
                        antialias: true,
                        backgroundAlpha: 0,
                        autoStart: false,
                        sharedTicker: false
                      })).then(function() {
                        application = app;
                        appRef.current = app;
                        return app;
                      });
                    });
                  }
                }));
              }
            }).then(function(board) {
              return board.ready.then(function() {
                if (destroyed) {
                  board.destroy();
                  return;
                }
                instance = board;
                boardRef.current = board;

                if (application && application.canvas && containerRef.current) {
                  application.canvas.style.position = 'absolute';
                  application.canvas.style.top = '0';
                  application.canvas.style.left = '0';
                  application.canvas.style.width = '100%';
                  application.canvas.style.height = '100%';
                  containerRef.current.appendChild(application.canvas);
                }

                board.on('change', function(e) {
                  if (syncingRef.current) return;
                  if (e.changeSet && e.changeSet.origin === 'load') return;
                  var latestDoc = board.document.toJSON();
                  fetch('/xindong-canvas/boards/' + encodeURIComponent(sessionId) + '/replace', {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      expectedRevision: localRevRef.current,
                      document: latestDoc
                    })
                  })
                    .then(function(res) { return res.ok ? res.json() : null; })
                    .then(function(result) {
                      if (result) {
                        localRevRef.current = result.revision;
                        setDoc(result.document);
                      }
                    })
                    .catch(function(err) {
                      console.error('[dsh-canvas] push error:', err);
                    });
                });
              });
            });
          })
          .catch(function(err) {
            console.error('[dsh-canvas] failed to init PixiBoard:', err);
          });

        return function() {
          destroyed = true;
          if (instance) instance.destroy();
          boardRef.current = null;
        };
      }, [sessionId]);

      var addRect = function() {
        var cx = 100 + Math.random() * 200;
        var cy = 100 + Math.random() * 200;
        fetch('/xindong-canvas/boards/' + encodeURIComponent(sessionId) + '/write', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: localRevRef.current,
            operations: [{
              type: 'create',
              nodes: [{
                type: 'rect',
                x: cx,
                y: cy,
                width: 160,
                height: 100,
                props: { fill: 0x3b82f6 }
              }]
            }]
          })
        })
          .then(function(res) { return res.ok ? res.json() : null; })
          .then(function(data) {
            if (!data) return;
            localRevRef.current = data.revision;
            setDoc(data.document);
            if (boardRef.current) {
              syncingRef.current = true;
              boardRef.current.document.load(data.document).finally(function() {
                syncingRef.current = false;
              });
            }
          })
          .catch(console.error);
      };

      var addText = function() {
        var cx = 120 + Math.random() * 200;
        var cy = 120 + Math.random() * 200;
        fetch('/xindong-canvas/boards/' + encodeURIComponent(sessionId) + '/write', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: localRevRef.current,
            operations: [{
              type: 'create',
              nodes: [{
                type: 'text',
                x: cx,
                y: cy,
                width: 200,
                height: 40,
                props: { text: 'New Canvas Note', style: { fill: 0xffffff, fontSize: 16 } }
              }]
            }]
          })
        })
          .then(function(res) { return res.ok ? res.json() : null; })
          .then(function(data) {
            if (!data) return;
            localRevRef.current = data.revision;
            setDoc(data.document);
            if (boardRef.current) {
              syncingRef.current = true;
              boardRef.current.document.load(data.document).finally(function() {
                syncingRef.current = false;
              });
            }
          })
          .catch(console.error);
      };

      var fitAll = function() {
        if (boardRef.current && doc && doc.nodes && doc.nodes.length > 0) {
          var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (var i = 0; i < doc.nodes.length; i++) {
            var n = doc.nodes[i];
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + n.width);
            maxY = Math.max(maxY, n.y + n.height);
          }
          boardRef.current.viewport.fitBounds({ minX: minX, minY: minY, maxX: maxX, maxY: maxY }, { padding: 40 });
        }
      };

      return React.createElement(
        'div',
        {
          style: {
            position: 'relative',
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#0f172a',
            color: '#e2e8f0',
            overflow: 'hidden',
            fontFamily: 'system-ui, -apple-system, sans-serif'
          }
        },
        React.createElement(
          'div',
          {
            style: {
              height: '42px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 12px',
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              backdropFilter: 'blur(8px)',
              zIndex: 10
            }
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            React.createElement('span', { style: { fontWeight: 600, fontSize: '13px', color: '#38bdf8' } }, 'PixiBoard Canvas'),
            React.createElement('span', { style: { fontSize: '11px', color: '#64748b' } }, 'r' + (doc ? doc.revision : 0) + ' | ' + (doc && doc.nodes ? doc.nodes.length : 0) + ' nodes')
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            React.createElement('button', {
              onClick: addRect,
              style: {
                background: '#1e293b',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#f8fafc',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '12px',
                cursor: 'pointer'
              }
            }, '+ 矩形'),
            React.createElement('button', {
              onClick: addText,
              style: {
                background: '#1e293b',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#f8fafc',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '12px',
                cursor: 'pointer'
              }
            }, '+ 文本'),
            React.createElement('button', {
              onClick: fitAll,
              style: {
                background: '#1e293b',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#f8fafc',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '12px',
                cursor: 'pointer'
              }
            }, '适应画布')
          )
        ),
        React.createElement(
          'div',
          {
            ref: containerRef,
            style: {
              flex: 1,
              position: 'relative',
              width: '100%',
              height: '100%',
              overflow: 'hidden'
            }
          }
        )
      );
    }

    return module.exports;
  }
});
