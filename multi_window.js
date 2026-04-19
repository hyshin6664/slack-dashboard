// ============================================================
// [v0.4] Slack 대시보드 - 멀티 윈도우 + 팝업 도우미
// ============================================================

(function() {
    'use strict';

    var MOBILE_WIDTH = 768;
    var CHAT_WIN_WIDTH = 400;
    var CHAT_WIN_HEIGHT = 620;
    var POPUP_CHECK_DELAY = 200;

    function isMobile() {
        return window.innerWidth < MOBILE_WIDTH;
    }

    function detectBrowser() {
        var ua = navigator.userAgent;
        var isMac = /Mac|iPhone|iPad|iPod/.test(ua);
        if (/Edg\//.test(ua)) return { name: 'Edge', isMac: isMac };
        if (/Chrome\//.test(ua)) return { name: 'Chrome', isMac: isMac };
        if (/Firefox\//.test(ua)) return { name: 'Firefox', isMac: isMac };
        if (/Safari\//.test(ua)) return { name: 'Safari', isMac: isMac };
        return { name: 'Unknown', isMac: isMac };
    }

    function isPopupBlocked(popup) {
        if (!popup) return true;
        if (popup.closed) return true;
        if (typeof popup.closed === 'undefined') return true;
        return false;
    }

    function createHelpModal() {
        var existing = document.getElementById('popupHelpModal');
        if (existing) existing.remove();

        var modal = document.createElement('div');
        modal.id = 'popupHelpModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999999;display:none;align-items:center;justify-content:center;padding:20px;';

        var browser = detectBrowser();
        var instructions = getBrowserInstructions(browser);

        modal.innerHTML =
            '<div style="background:white;border-radius:16px;padding:25px;max-width:500px;width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);">' +
                '<div style="display:flex;align-items:center;gap:10px;margin-bottom:15px;">' +
                    '<div style="font-size:32px;">🚫</div>' +
                    '<div>' +
                        '<h3 style="margin:0;color:#1e293b;font-size:18px;">팝업이 차단됐어요!</h3>' +
                        '<div style="font-size:12px;color:#64748b;margin-top:4px;">대화방을 별도 창으로 열려면 팝업 허용이 필요해요</div>' +
                    '</div>' +
                '</div>' +
                '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:15px;margin-bottom:15px;">' +
                    '<div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:8px;">감지된 브라우저</div>' +
                    '<div style="font-size:14px;font-weight:700;color:#1e293b;">' + browser.name + (browser.isMac ? ' (Mac)' : ' (Windows)') + '</div>' +
                '</div>' +
                '<div style="background:#dbeafe;border-left:4px solid #3b82f6;padding:15px;border-radius:8px;margin-bottom:15px;">' +
                    '<div style="font-size:13px;font-weight:800;color:#1e3a8a;margin-bottom:10px;">🔓 팝업 허용 방법</div>' +
                    '<div style="font-size:13px;color:#1e40af;line-height:1.8;">' + instructions + '</div>' +
                '</div>' +
                '<div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px;border-radius:8px;margin-bottom:15px;font-size:12px;color:#78350f;">' +
                    '💡 <strong>참고:</strong> 팝업을 허용해도 우리 대시보드에서만 뜨는 거예요. 다른 사이트 영향 없어요.' +
                '</div>' +
                '<div style="display:flex;gap:10px;">' +
                    '<button id="popupHelpRetry" style="flex:1;padding:12px;background:#10b981;color:white;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;">🔄 다시 시도</button>' +
                    '<button id="popupHelpClose" style="flex:1;padding:12px;background:#e2e8f0;color:#475569;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;">닫기</button>' +
                '</div>' +
            '</div>';

        modal.addEventListener('click', function(e) {
            if (e.target === modal) closeHelpModal();
        });

        document.body.appendChild(modal);

        document.getElementById('popupHelpClose').addEventListener('click', closeHelpModal);
        document.getElementById('popupHelpRetry').addEventListener('click', function() {
            closeHelpModal();
            if (window._lastBlockedChat) {
                setTimeout(function() {
                    tryOpenChatWindow(window._lastBlockedChat.type, window._lastBlockedChat.id);
                }, 100);
            }
        });

        return modal;
    }

    function getBrowserInstructions(browser) {
        var name = browser.name;
        if (name === 'Chrome') {
            return '1. 주소창 오른쪽의 <strong>🔒 자물쇠 아이콘</strong> 클릭<br>' +
                   '2. <strong>"팝업 및 리디렉션"</strong> 찾기<br>' +
                   '3. <strong>"허용"</strong> 으로 변경<br>' +
                   '4. 페이지 새로고침 (F5)';
        } else if (name === 'Edge') {
            return '1. 주소창 오른쪽의 <strong>🔒 자물쇠 아이콘</strong> 클릭<br>' +
                   '2. <strong>"이 사이트에 대한 권한"</strong> 클릭<br>' +
                   '3. <strong>"팝업 및 리디렉션"</strong> → <strong>"허용"</strong><br>' +
                   '4. 페이지 새로고침 (F5)';
        } else if (name === 'Firefox') {
            return '1. 주소창에 <strong>차단 아이콘</strong> 클릭<br>' +
                   '2. <strong>"팝업 허용"</strong> 선택<br>' +
                   '3. 페이지 새로고침 (F5)';
        } else if (name === 'Safari') {
            if (browser.isMac) {
                return '<strong>Mac Safari:</strong><br>' +
                       '1. 상단 <strong>Safari 메뉴 → 설정</strong><br>' +
                       '2. <strong>웹사이트</strong> 탭 → <strong>팝업 창</strong><br>' +
                       '3. 현재 사이트를 <strong>"허용"</strong> 으로<br>' +
                       '4. 페이지 새로고침';
            } else {
                return '<strong>iOS Safari:</strong><br>' +
                       '1. <strong>설정 앱</strong> → <strong>Safari</strong><br>' +
                       '2. <strong>"팝업 차단"</strong> 끄기<br>' +
                       '3. 페이지 새로고침';
            }
        } else {
            return '브라우저 설정에서 <strong>팝업 허용</strong>을 찾아 켜주세요.';
        }
    }

    function showHelpModal() {
        var modal = document.getElementById('popupHelpModal') || createHelpModal();
        modal.style.display = 'flex';
    }

    function closeHelpModal() {
        var modal = document.getElementById('popupHelpModal');
        if (modal) modal.style.display = 'none';
    }

    function tryOpenChatWindow(type, id) {
        window._lastBlockedChat = { type: type, id: id };

        var url = window.location.pathname + '?chat=' + encodeURIComponent(id) +
                  '&type=' + encodeURIComponent(type);

        var left = Math.max(0, (window.screen.width - CHAT_WIN_WIDTH) / 2);
        var top = Math.max(0, (window.screen.height - CHAT_WIN_HEIGHT) / 2);

        var features =
            'width=' + CHAT_WIN_WIDTH +
            ',height=' + CHAT_WIN_HEIGHT +
            ',left=' + left +
            ',top=' + top +
            ',resizable=yes,scrollbars=yes';

        var winName = 'slack_chat_' + id;
        var popup = window.open(url, winName, features);

        if (isPopupBlocked(popup)) {
            showHelpModal();
            return false;
        }

        setTimeout(function() {
            if (popup && popup.closed) {
                showHelpModal();
            }
        }, POPUP_CHECK_DELAY);

        try { popup.focus(); } catch(e) {}
        return true;
    }

    function patchOpenSlackChatPopup() {
        if (typeof window.openSlackChatPopup !== 'function') {
            console.log('[multi-window] openSlackChatPopup 없음. 1초 후 재시도.');
            setTimeout(patchOpenSlackChatPopup, 1000);
            return;
        }

        if (window.openSlackChatPopup._patched) return;

        var original = window.openSlackChatPopup;

        window.openSlackChatPopup = function(type, id) {
            if (isMobile()) {
                return original.apply(this, arguments);
            }
            if (type === 'canvas') {
                return original.apply(this, arguments);
            }
            if (type === 'friends') {
                return original.apply(this, arguments);
            }
            if (typeof id === 'string' && id.indexOf('__user_') === 0) {
                return original.apply(this, arguments);
            }

            var ok = tryOpenChatWindow(type, id);
            if (!ok) {
                return original.apply(this, arguments);
            }
        };

        window.openSlackChatPopup._patched = true;
        window.openSlackChatPopup._original = original;
        console.log('[multi-window] openSlackChatPopup 패치 완료!');
    }

    function addHelpButton() {
        var actions = document.querySelector('.top-bar-actions');
        if (!actions) {
            setTimeout(addHelpButton, 500);
            return;
        }

        if (document.getElementById('multiWinHelpBtn')) return;

        var btn = document.createElement('button');
        btn.id = 'multiWinHelpBtn';
        btn.className = 'sim-btn';
        btn.title = '대화창 팝업이 안 열릴 때 도움말';
        btn.textContent = '❓ 도움말';
        btn.addEventListener('click', showHelpModal);

        actions.appendChild(btn);
        console.log('[multi-window] 도움말 버튼 추가!');
    }

    function handleChildWindowMode() {
        var params = new URLSearchParams(window.location.search);
        var chatId = params.get('chat');
        var chatType = params.get('type');

        if (!chatId) return;

        console.log('[multi-window] 자식 창 모드:', chatType, chatId);

        var waitForUi = setInterval(function() {
            var layout = document.querySelector('.slack-layout');
            if (!layout) return;

            clearInterval(waitForUi);

            layout.style.display = 'none';
            var banner = document.querySelector('.slack-demo-banner');
            if (banner) banner.style.display = 'none';
            var topBar = document.querySelector('.top-bar');
            if (topBar) topBar.style.display = 'none';

            document.body.style.background = '#b2c7d9';

            if (typeof window.openSlackChatPopup === 'function') {
                setTimeout(function() {
                    try {
                        if (window.openSlackChatPopup._original) {
                            window.openSlackChatPopup._original(chatType, chatId);
                        } else {
                            window.openSlackChatPopup(chatType, chatId);
                        }

                        setTimeout(function() {
                            var popup = document.querySelector('.slack-popup');
                            if (popup) {
                                popup.style.position = 'fixed';
                                popup.style.inset = '0';
                                popup.style.width = '100%';
                                popup.style.height = '100%';
                                popup.style.borderRadius = '0';
                            }
                        }, 300);
                    } catch(e) {
                        console.error('[multi-window] 자식 창 오류:', e);
                    }
                }, 500);
            }
        }, 200);

        setTimeout(function() { clearInterval(waitForUi); }, 10000);
    }

    var broadcastChannel = null;
    function setupBroadcastChannel() {
        if (typeof BroadcastChannel === 'undefined') {
            console.log('[multi-window] BroadcastChannel 미지원');
            return;
        }

        broadcastChannel = new BroadcastChannel('slack-dashboard');

        broadcastChannel.addEventListener('message', function(event) {
            var msg = event.data;
            if (!msg || !msg.type) return;
            if (msg.type === 'new_message') {
                console.log('[multi-window] 다른 창에서 새 메시지 알림:', msg);
            }
        });

        console.log('[multi-window] BroadcastChannel 연결!');
    }

    function broadcast(type, data) {
        if (broadcastChannel) {
            try {
                broadcastChannel.postMessage({ type: type, data: data });
            } catch(e) {
                console.log('[multi-window] broadcast 오류:', e);
            }
        }
    }

    window.slackMultiWindow = {
        broadcast: broadcast,
        showHelp: showHelpModal,
        isMobile: isMobile
    };

    function init() {
        console.log('[multi-window] 초기화 시작');
        setupBroadcastChannel();
        handleChildWindowMode();
        setTimeout(addHelpButton, 1000);
        setTimeout(patchOpenSlackChatPopup, 1500);
        console.log('[multi-window] 초기화 완료!');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
