angular.module('appControllers').controller('TerminalCtrl', TerminalCtrl);
TerminalCtrl.$inject = ['$rootScope', '$scope', '$http', '$timeout'];

function TerminalCtrl($rootScope, $scope, $http, $timeout) {
	$scope.$parent.helppage = 'plates/terminal-help.html';

	$scope.termConnected = false;
	$scope.termFontSize = '14';
	$scope.termIdleWarning = false;
	$scope.termIdleRemaining = 0;

	var ws = null;
	var termContainer = null;
	var termElement = null;
	var MAX_SCROLLBACK = 5000;

	// Simple terminal renderer using a pre element
	function initTerminal() {
		termContainer = document.getElementById('terminal-container');
		if (!termContainer) return;

		// Clear any existing content
		termContainer.innerHTML = '';

		// Create terminal element
		termElement = document.createElement('pre');
		termElement.style.cssText = 'margin:0; padding:8px; color:#0f0; background:#000; font-family:monospace; ' +
			'font-size:' + $scope.termFontSize + 'px; overflow-y:auto; height:100%; width:100%; ' +
			'white-space:pre-wrap; word-wrap:break-word; outline:none; cursor:text;';
		termElement.setAttribute('tabindex', '0');
		termContainer.appendChild(termElement);

		// Focus the terminal
		termElement.focus();

		// Handle keyboard input
		termElement.addEventListener('keydown', handleKeyDown);
		termElement.addEventListener('paste', handlePaste);

		// Click to focus
		termContainer.addEventListener('click', function() {
			termElement.focus();
		});
	}

	function handleKeyDown(e) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;

		// Prevent default for most keys to avoid browser shortcuts
		var key = e.key;
		var code = e.keyCode;

		if (e.ctrlKey) {
			// Ctrl+C, Ctrl+D, Ctrl+Z, etc - send as control characters
			if (code >= 65 && code <= 90) {
				e.preventDefault();
				var ctrlChar = String.fromCharCode(code - 64);
				ws.send(ctrlChar);
				return;
			}
			// Ctrl+Shift+C = copy, Ctrl+Shift+V = paste - allow default
			if (e.shiftKey && (code === 67 || code === 86)) return;
			return;
		}

		if (e.altKey || e.metaKey) return;

		e.preventDefault();

		switch (key) {
			case 'Enter':
				ws.send('\r');
				break;
			case 'Backspace':
				ws.send('\x7f');
				break;
			case 'Tab':
				ws.send('\t');
				break;
			case 'Escape':
				ws.send('\x1b');
				break;
			case 'ArrowUp':
				ws.send('\x1b[A');
				break;
			case 'ArrowDown':
				ws.send('\x1b[B');
				break;
			case 'ArrowRight':
				ws.send('\x1b[C');
				break;
			case 'ArrowLeft':
				ws.send('\x1b[D');
				break;
			case 'Home':
				ws.send('\x1b[H');
				break;
			case 'End':
				ws.send('\x1b[F');
				break;
			case 'Delete':
				ws.send('\x1b[3~');
				break;
			case 'PageUp':
				ws.send('\x1b[5~');
				break;
			case 'PageDown':
				ws.send('\x1b[6~');
				break;
			default:
				if (key.length === 1) {
					ws.send(key);
				}
				break;
		}
	}

	function handlePaste(e) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		e.preventDefault();
		var text = (e.clipboardData || window.clipboardData).getData('text');
		if (text) {
			ws.send(text);
		}
	}

	// Strip ANSI escape sequences for the simple renderer
	function stripAnsi(str) {
		return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
				  .replace(/\x1b\][^\x07]*\x07/g, '')
				  .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
				  .replace(/\x1b[()][0-9A-B]/g, '')
				  .replace(/\x1b\x5D[^\x07\x1b]*(\x07|\x1b\\)/g, '')
				  .replace(/[\x00-\x08\x0E-\x1F]/g, '');
	}

	function appendOutput(text) {
		if (!termElement) return;
		// For the simple terminal, strip ANSI codes and append
		var clean = stripAnsi(text);
		termElement.textContent += clean;

		// Trim scrollback if needed
		var lines = termElement.textContent.split('\n');
		if (lines.length > MAX_SCROLLBACK) {
			lines = lines.slice(lines.length - MAX_SCROLLBACK);
			termElement.textContent = lines.join('\n');
		}

		// Auto scroll to bottom
		termElement.scrollTop = termElement.scrollHeight;
	}

	function connectTerminal() {
		if (ws && ws.readyState === WebSocket.OPEN) return;

		ws = new WebSocket(URL_TERMINAL_WS);
		ws.binaryType = 'arraybuffer';

		ws.onopen = function() {
			$scope.$apply(function() {
				$scope.termConnected = true;
				$scope.termIdleWarning = false;
			});

			// Send initial resize based on container size
			sendResize();
		};

		ws.onmessage = function(event) {
			if (typeof event.data === 'string') {
				// Try to parse as JSON control message
				try {
					var msg = JSON.parse(event.data);
					if (msg.type === 'status') {
						handleStatusMessage(msg);
						return;
					}
				} catch(e) {
					// Not JSON, treat as text output
				}
				appendOutput(event.data);
			} else if (event.data instanceof ArrayBuffer) {
				// Binary data from PTY
				var text = new TextDecoder().decode(event.data);
				appendOutput(text);
			}
		};

		ws.onclose = function(event) {
			$scope.$apply(function() {
				$scope.termConnected = false;
			});
			if (event.code !== 1000) {
				// Abnormal close - attempt reconnect after delay
				$timeout(function() {
					if (!$scope.termConnected) {
						appendOutput('\r\n[Connection lost. Click Reconnect to start a new session.]\r\n');
					}
				}, 1000);
			}
		};

		ws.onerror = function(err) {
			$scope.$apply(function() {
				$scope.termConnected = false;
			});
		};
	}

	function handleStatusMessage(msg) {
		$scope.$apply(function() {
			switch (msg.msg) {
				case 'connected':
					$scope.termConnected = true;
					break;
				case 'rejected':
					$scope.termConnected = false;
					appendOutput('[Connection rejected: ' + (msg.reason || 'max sessions') + ']\r\n');
					break;
				case 'idle_warning':
					$scope.termIdleWarning = true;
					$scope.termIdleRemaining = msg.remainingSec || 60;
					break;
				case 'idle_timeout':
					$scope.termIdleWarning = false;
					appendOutput('\r\n[Session terminated: idle timeout]\r\n');
					break;
				case 'exited':
					$scope.termConnected = false;
					appendOutput('\r\n[Session ended (exit code: ' + (msg.code || 0) + ')]\r\n');
					break;
			}
		});
	}

	function sendResize() {
		if (!ws || ws.readyState !== WebSocket.OPEN || !termContainer) return;
		var fontSize = parseInt($scope.termFontSize) || 14;
		var charWidth = fontSize * 0.6;
		var charHeight = fontSize * 1.2;
		var cols = Math.floor(termContainer.clientWidth / charWidth) || 80;
		var rows = Math.floor(termContainer.clientHeight / charHeight) || 24;
		ws.send(JSON.stringify({type: 'resize', cols: cols, rows: rows}));
	}

	// Public scope functions
	$scope.termReconnect = function() {
		if (ws) {
			ws.close();
			ws = null;
		}
		if (termElement) {
			termElement.textContent = '';
		}
		connectTerminal();
	};

	$scope.termClear = function() {
		if (termElement) {
			termElement.textContent = '';
		}
	};

	$scope.termSetFontSize = function() {
		if (termElement) {
			termElement.style.fontSize = $scope.termFontSize + 'px';
		}
		sendResize();
	};

	$scope.termClose = function() {
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send('exit\r');
			$timeout(function() {
				if (ws) ws.close();
			}, 500);
		}
	};

	// Handle window resize
	var resizeTimer;
	var handleResize = function() {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(function() {
			sendResize();
		}, 250);
	};
	window.addEventListener('resize', handleResize);

	// Initialize on load
	$timeout(function() {
		initTerminal();
		connectTerminal();
	}, 100);

	// Clean up on scope destroy
	$scope.$on('$destroy', function() {
		if (ws) {
			ws.close();
			ws = null;
		}
		window.removeEventListener('resize', handleResize);
	});
}
