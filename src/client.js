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
      var t = ctx.locale ? ctx.locale.bind(NS) : function(k) { return k === 'view.canvas' ? '画布' : k; };

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

      // Poll for remote updates from Agent
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
                    if (appRef.current && appRef.current.render) {
                      appRef.current.render();
                    }
                  });
                }
              }
            })
            .catch(function() {});
        }, 1200);
        return function() { clearInterval(timer); };
      }, [sessionId, fetchDoc]);

      // Initialize PixiBoard & Pixi Application
      useEffect(function() {
        var destroyed = false;
        var instance = null;
        var app = null;

        if (!containerRef.current) return;
        var containerEl = containerRef.current;

        import('/xindong-canvas/pixiboard.js')
          .then(function(mod) {
            if (destroyed) return;
            var createPixiBoard = mod.createPixiBoard;
            var PixiBoardRenderer = mod.PixiBoardRenderer;
            var createPixiApplicationFactory = mod.createPixiApplicationFactory;
            var PIXI = mod.PIXI;

            var initialDoc = doc || {
              schemaVersion: 1,
              revision: localRevRef.current,
              nodes: [],
              assets: [],
              viewport: { scale: 1, offset: { x: 0, y: 0 } }
            };

            var appFactory = createPixiApplicationFactory({
              resizeTo: containerEl,
              antialias: true,
              backgroundAlpha: 0,
              autoStart: false,
              sharedTicker: false
            });

            return createPixiBoard({
              container: containerEl,
              document: initialDoc,
              interactions: { pointer: true, keyboard: true },
              rendererFactory: function(options) {
                var renderer = new PixiBoardRenderer(Object.assign({}, options, {
                  applicationFactory: function() {
                    return appFactory().then(function(createdApp) {
                      app = createdApp;
                      appRef.current = createdApp;
                      return createdApp;
                    });
                  }
                }));

                // Register rich custom shape renderers if PIXI is available
                if (PIXI && renderer.registry) {
                  registerCustomRenderers(renderer.registry, PIXI);
                }

                return renderer;
              }
            }).then(function(board) {
              return board.ready.then(function() {
                if (destroyed) {
                  board.destroy();
                  return;
                }
                instance = board;
                boardRef.current = board;

                // Mount Pixi canvas
                if (app && app.canvas && containerEl) {
                  app.canvas.style.position = 'absolute';
                  app.canvas.style.top = '0';
                  app.canvas.style.left = '0';
                  app.canvas.style.width = '100%';
                  app.canvas.style.height = '100%';
                  app.canvas.style.display = 'block';
                  app.canvas.style.outline = 'none';
                  containerEl.appendChild(app.canvas);
                }

                // Wire stage transform with board viewport
                var syncStage = function() {
                  if (!app || !app.stage) return;
                  var vp = board.viewport.get();
                  app.stage.scale.set(vp.scale, vp.scale);
                  app.stage.position.set(vp.offset.x, vp.offset.y);
                  if (app.render) app.render();
                };

                board.on('viewport:change', syncStage);
                syncStage();

                // Initial render after small delay to ensure DOM dimensions
                setTimeout(function() {
                  if (destroyed) return;
                  syncStage();
                  fitBoard(board);
                }, 100);

                // Wire pan & zoom interactions on container
                setupCanvasInteractions(containerEl, board, syncStage);

                // Listen for local changes to sync back to Host
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
          appRef.current = null;
          if (app && app.canvas && app.canvas.parentNode) {
            app.canvas.parentNode.removeChild(app.canvas);
          }
        };
      }, [sessionId]);

      function fitBoard(board) {
        if (!board) return;
        var currentDoc = board.document.toJSON();
        if (currentDoc && currentDoc.nodes && currentDoc.nodes.length > 0) {
          var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (var i = 0; i < currentDoc.nodes.length; i++) {
            var n = currentDoc.nodes[i];
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + (n.width || 120));
            maxY = Math.max(maxY, n.y + (n.height || 80));
          }
          var pad = 60;
          board.viewport.fitBounds({
            minX: minX - pad,
            minY: minY - pad,
            maxX: maxX + pad,
            maxY: maxY + pad
          });
        }
      }

      var addRect = function() {
        var cx = 150 + Math.random() * 200;
        var cy = 150 + Math.random() * 200;
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
                if (appRef.current && appRef.current.render) appRef.current.render();
              });
            }
          })
          .catch(console.error);
      };

      var addText = function() {
        var cx = 180 + Math.random() * 200;
        var cy = 180 + Math.random() * 200;
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
                width: 220,
                height: 40,
                props: { text: 'New Canvas Note 📝', style: { fill: 0xffffff, fontSize: 16 } }
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
                if (appRef.current && appRef.current.render) appRef.current.render();
              });
            }
          })
          .catch(console.error);
      };

      var fitAll = function() {
        if (boardRef.current) {
          fitBoard(boardRef.current);
          if (appRef.current && appRef.current.render) appRef.current.render();
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
            backgroundColor: '#090d16',
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
              padding: '0 16px',
              backgroundColor: 'rgba(15, 23, 42, 0.9)',
              backdropFilter: 'blur(8px)',
              zIndex: 10,
              userSelect: 'none'
            }
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            React.createElement('span', { style: { fontWeight: 600, fontSize: '13px', color: '#38bdf8' } }, 'PixiBoard Canvas'),
            React.createElement('span', {
              style: {
                fontSize: '11px',
                color: '#94a3b8',
                backgroundColor: 'rgba(255,255,255,0.06)',
                padding: '2px 8px',
                borderRadius: '12px'
              }
            }, 'r' + (doc ? doc.revision : 0) + ' | ' + (doc && doc.nodes ? doc.nodes.length : 0) + ' nodes')
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            React.createElement('button', {
              onClick: addRect,
              style: {
                background: '#1e293b',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#f8fafc',
                padding: '4px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.15s'
              }
            }, '+ 矩形'),
            React.createElement('button', {
              onClick: addText,
              style: {
                background: '#1e293b',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#f8fafc',
                padding: '4px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.15s'
              }
            }, '+ 文本'),
            React.createElement('button', {
              onClick: fitAll,
              style: {
                background: '#0284c7',
                border: '1px solid rgba(255,255,255,0.15)',
                color: '#ffffff',
                padding: '4px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.15s'
              }
            }, '适应画布')
          )
        ),
        React.createElement(
          'div',
          {
            ref: containerRef,
            tabIndex: 0,
            style: {
              flex: 1,
              position: 'relative',
              width: '100%',
              height: '100%',
              overflow: 'hidden',
              cursor: 'grab',
              outline: 'none',
              backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)',
              backgroundSize: '24px 24px'
            }
          }
        )
      );
    }

    // Register rich custom shape renderers for shapes created by Agent
    function registerCustomRenderers(registry, PIXI) {
      function applyCommonTransform(view, node) {
        var d = view.displayObject;
        d.x = node.x;
        d.y = node.y;
        d.rotation = node.rotation || 0;
        d.zIndex = node.zIndex || 0;
      }

      // Ellipse / Circle
      registry.register('ellipse', {
        create: function(node) {
          var g = new PIXI.Graphics();
          var w = node.width || 100;
          var h = node.height || 100;
          var fill = (node.props && node.props.fill) !== undefined ? node.props.fill : 0x3b82f6;
          g.ellipse(w / 2, h / 2, w / 2, h / 2).fill(fill);
          return { displayObject: g, state: {} };
        },
        update: function(view, node) {
          applyCommonTransform(view, node);
        },
        destroy: function(view) {
          view.displayObject.destroy({ children: true });
        }
      });

      registry.register('circle', {
        create: function(node) {
          var g = new PIXI.Graphics();
          var r = (node.width || 100) / 2;
          var fill = (node.props && node.props.fill) !== undefined ? node.props.fill : 0x3b82f6;
          g.circle(r, r, r).fill(fill);
          return { displayObject: g, state: {} };
        },
        update: function(view, node) {
          applyCommonTransform(view, node);
        },
        destroy: function(view) {
          view.displayObject.destroy({ children: true });
        }
      });

      // Star shape
      registry.register('star', {
        create: function(node) {
          var g = new PIXI.Graphics();
          var w = node.width || 100;
          var h = node.height || 100;
          var r = Math.min(w, h) / 2;
          var fill = (node.props && node.props.fill) !== undefined ? node.props.fill : 0xeab308;
          g.star(r, r, 5, r, r * 0.45).fill(fill);
          return { displayObject: g, state: {} };
        },
        update: function(view, node) {
          applyCommonTransform(view, node);
        },
        destroy: function(view) {
          view.displayObject.destroy({ children: true });
        }
      });
    }

    // Pan & Zoom gestures on canvas
    function setupCanvasInteractions(container, board, syncStage) {
      var isDragging = false;
      var lastPos = { x: 0, y: 0 };

      container.addEventListener('pointerdown', function(e) {
        if (e.button === 0 || e.button === 1) {
          isDragging = true;
          lastPos = { x: e.clientX, y: e.clientY };
          container.style.cursor = 'grabbing';
          container.setPointerCapture(e.pointerId);
        }
      });

      container.addEventListener('pointermove', function(e) {
        if (!isDragging) return;
        var dx = e.clientX - lastPos.x;
        var dy = e.clientY - lastPos.y;
        lastPos = { x: e.clientX, y: e.clientY };
        board.viewport.panBy(dx, dy);
        syncStage();
      });

      var endDrag = function(e) {
        if (isDragging) {
          isDragging = false;
          container.style.cursor = 'grab';
          try { container.releasePointerCapture(e.pointerId); } catch(err) {}
        }
      };

      container.addEventListener('pointerup', endDrag);
      container.addEventListener('pointercancel', endDrag);

      container.addEventListener('wheel', function(e) {
        e.preventDefault();
        var rect = container.getBoundingClientRect();
        var screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        if (e.ctrlKey || e.metaKey) {
          var factor = Math.exp(-e.deltaY * 0.01);
          board.viewport.zoomAt(screenPoint, factor);
        } else {
          board.viewport.panBy(-e.deltaX, -e.deltaY);
        }
        syncStage();
      }, { passive: false });
    }

    return module.exports;
  }
});
