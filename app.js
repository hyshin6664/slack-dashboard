<script>
    // ============================================================
    // [v3.2] google.script.run → JSONP 어댑터 (GitHub Pages용)
    // ============================================================
    // GitHub Pages는 Apps Script HtmlService 외부이므로 google.script.run이 없음.
    // 동일한 호출 문법 그대로 JSONP로 변환해서 /exec 호출.
    // 기존 클라이언트 코드(아래)는 한 줄도 수정하지 않아도 됨.
    // ============================================================
    (function() {
        var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw8fLY8VSJLmYZJ1rcPtcDgQ3j-fJSci8PuYwX12U_fg52atFWaXsmIGZHiV2gWnjRCrg/exec';

        function jsonpCall(action, args, onSuccess, onFailure) {
            var cbName = '_gsr_' + Date.now() + '_' + Math.floor(Math.random() * 1e9);
            var timeoutId = setTimeout(function() {
                cleanup();
                if (onFailure) onFailure('timeout: ' + action);
            }, 30000);
            function cleanup() {
                clearTimeout(timeoutId);
                try { delete window[cbName]; } catch(e) { window[cbName] = undefined; }
                var s = document.getElementById(cbName);
                if (s && s.parentNode) s.parentNode.removeChild(s);
            }
            window[cbName] = function(result) {
                cleanup();
                if (onSuccess) {
                    try { onSuccess(result); } catch(e) { console.error('[gsr success cb]', action, e); }
                }
            };
            var script = document.createElement('script');
            script.id = cbName;
            script.onerror = function() {
                cleanup();
                if (onFailure) onFailure('network error: ' + action);
            };
            try {
                script.src = APPS_SCRIPT_URL +
                    '?action=' + encodeURIComponent(action) +
                    '&args=' + encodeURIComponent(JSON.stringify(args || [])) +
                    '&callback=' + cbName;
            } catch(e) {
                cleanup();
                if (onFailure) onFailure('arg encode fail: ' + e.message);
                return;
            }
            document.body.appendChild(script);
        }

        function makeRunner(success, failure) {
            return new Proxy({}, {
                get: function(_, prop) {
                    if (prop === 'withSuccessHandler') {
                        return function(cb) { return makeRunner(cb, failure); };
                    }
                    if (prop === 'withFailureHandler') {
                        return function(cb) { return makeRunner(success, cb); };
                    }
                    if (prop === 'withUserObject') {
                        return function() { return makeRunner(success, failure); };
                    }
                    // terminal call: google.script.run.fnName(arg1, arg2)
                    return function() {
                        var args = Array.prototype.slice.call(arguments);
                        jsonpCall(prop, args, success, failure);
                    };
                }
            });
        }

        // HtmlService 안에서 진짜 google.script.run이 있으면 그대로 사용,
        // 외부(GitHub Pages)면 JSONP 어댑터 주입.
        if (typeof window.google === 'undefined' || !window.google.script || !window.google.script.run) {
            window.google = window.google || {};
            window.google.script = window.google.script || {};
            window.google.script.run = makeRunner(null, null);
            console.log('[v3.2] google.script.run JSONP 어댑터 활성화 (GitHub Pages 모드)');
        }
    })();

    // ============================================================
    // [v0.2] 개인대시보드 Slack - 카카오톡 스타일 UI
    // ============================================================
    // OAuth 연동 전 UI 확인용. 더미 데이터 기반.
    // 추후 OAuth 연동 시 이 더미 데이터를 실제 Slack API 응답으로 교체.
    // ============================================================

    // ============================================================
    // 상태
    // ============================================================
    var currentSlackTab = 'dm';           // 'dm' | 'channel' | 'canvas'
    var slackSearchQuery = '';
    var openSlackPopups = [];             // [{ id, type, name, data, minimized, el }]
    var MAX_SLACK_POPUPS = 5;
    var nextSlackPopupZ = 500100;
    var toastTimeout;
    // [v0.5] 추가 상태
    var myUserName = '나';
    var popupUnreadMap = {};              // { popupId: unreadCount } - 최소화 상태에서 받은 새 메시지 수
    var EMOJI_PICKER_LIST = ['👍','❤️','😂','😮','😢','🙏','👏','🎉','🔥','💯','✨','✅','❌','⚠️','🤔','👀','🙌','💪','😊','☕'];
    var emojiPickerCallback = null;
    var activeMentionState = null;        // { popupId, startPos, members }
    // [v2.9] Delta 폴링 상태
    var focusedPopupId = '';              // 현재 포커스된 (대화 중인) 팝업 ID
    var slackDeltaInterval = null;        // 포커스 팝업 전용 1초 타이머
    var slackCacheInterval = null;        // 나머지 3초 타이머

    // ============================================================
    // [v0.8] 실제 데이터용 빈 배열 (더미 데이터 전부 제거)
    // Slack API에서 채워짐. 연결 안 된 상태에선 빈 목록 + 연동 버튼 표시.
    // ============================================================
    var dummyFriends = [];  // [v2.6] 친구 목록 (전체 멤버)
    var dummyDMs = [];
    var dummyChannels = [];
    var dummyCanvases = [];
    var dummyMessagesMap = {};

    // ============================================================
    // 공통 유틸
    // ============================================================
    function showToast(m) {
        var t = document.getElementById("toastMsg");
        if (!t) return;
        t.innerText = m;
        t.classList.add("show");
        if (toastTimeout) clearTimeout(toastTimeout);
        var duration = (m.indexOf("실패") !== -1 || m.indexOf("오류") !== -1) ? 5000 : 2500;
        toastTimeout = setTimeout(function() { t.classList.remove("show"); }, duration);
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function avatarColorFromName(name) {
        var palette = ['#fbbf24', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f59e0b'];
        var h = 0;
        for (var i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffff;
        return palette[Math.abs(h) % palette.length];
    }

    function firstCharOf(name) {
        if (!name) return '?';
        return name.charAt(0).toUpperCase();
    }

    // ============================================================
    // 초기화
    // ============================================================
    var slackUsersMap = {};       // [v0.6] 실제 사용자 이름 맵 { id: { name, email } }
    var slackMyUserId = '';       // [v0.6] 내 Slack user ID
    var slackRealMode = false;    // [v0.6] 실제 모드 여부

    // ============================================================
    // [v1.2] 연결 해제 → 재연동 가능
    // ============================================================
    function slackDisconnect() {
        if (!confirm('Slack 연결을 해제할까요?\n해제 후 다시 연동하면 새 권한이 적용돼요.\n\n(해제 후 "Slack 연동하기" 버튼이 나타나면 클릭해주세요)')) return;
        google.script.run
            .withSuccessHandler(function(res) {
                if (res && res.success) {
                    showToast('해제 완료! 연동 화면으로...');
                    slackRealMode = false;
                    // 바로 연동 화면 표시 (새로고침 대신!)
                    setTimeout(function() {
                        showSlackConnectScreen();
                    }, 500);
                } else {
                    showToast('해제 실패');
                }
            })
            .disconnectSlack();
    }

    // ============================================================
    // [v0.7] Slack 연동 (OAuth)
    // ============================================================
    function slackConnect() {
        showToast('Slack 연동 준비 중...');
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) {
                    showToast('연동 실패: ' + (res ? res.message : '오류'));
                    return;
                }
                if (res.connected) {
                    showToast('이미 연동됨! 새로고침...');
                    setTimeout(function() { location.reload(); }, 1000);
                    return;
                }
                if (res.url) {
                    window.open(res.url, '_blank');
                    showToast('새 탭에서 Slack "허용"을 클릭해주세요!');
                    // [v1.4] 폴링으로 연동 확인 (콜백 URL 재호출 안 함!)
                    var pollCount = 0;
                    var pollInterval = setInterval(function() {
                        pollCount++;
                        if (pollCount > 20) {
                            clearInterval(pollInterval);
                            showToast('새로고침(F5) 해주세요');
                            return;
                        }
                        google.script.run
                            .withSuccessHandler(function(s) {
                                if (s && s.success && s.connected) {
                                    clearInterval(pollInterval);
                                    showToast('연동 완료!');
                                    // 즉시 데이터 로드 (새로고침 안 함!)
                                    slackMyUserId = s.userId || '';
                                    loadRealSlackData();
                                }
                            })
                            .getSlackAuthStatus();
                    }, 3000);
                }
            })
            .withFailureHandler(function(err) { showToast('연동 실패: ' + err); })
            .getSlackAuthUrl();
    }

    window.onload = function() {
        try {
            // [v0.9] 즉시 스켈레톤 표시 (빈 화면 금지!)
            showSlackLoadingSkeleton();
            // [v0.7] 실제 Slack 연결 시도
            google.script.run
                .withSuccessHandler(function(res) {
                    if (res && res.success && res.connected) {
                        slackMyUserId = res.userId || '';
                        // 연동됨 → 실제 데이터 로드
                        loadRealSlackData();
                    } else {
                        // 연동 안 됨 → "Slack 연동하기" 버튼 표시
                        showSlackConnectScreen();
                    }
                })
                .withFailureHandler(function() {
                    showSlackConnectScreen();
                })
                .getSlackAuthStatus();
            updateBrowserTitle();
            // [v2.3] 자동 진단 제거 — 🔍 진단 버튼으로만 실행
            // [v0.5] 데스크톱 알림 권한 (조용히 요청)
            if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
                setTimeout(function() { try { Notification.requestPermission(); } catch(e) {} }, 3000);
            }
            // Esc 키로 가장 위 팝업 닫기 + 기타 패널
            document.addEventListener('keydown', function(e) {
                if (e.key !== 'Escape') return;
                // 모달/드롭다운 먼저 닫기
                var forwardModal = document.getElementById('slackForwardModal');
                if (forwardModal && forwardModal.classList.contains('visible')) { closeForwardModal(); return; }
                var profileModal = document.getElementById('slackProfileModal');
                if (profileModal && profileModal.classList.contains('visible')) { closeProfileModal(); return; }
                var picker = document.getElementById('emojiPicker');
                if (picker && picker.classList.contains('visible')) { picker.classList.remove('visible'); return; }
                var menu = document.getElementById('msgContextMenu');
                if (menu && menu.classList.contains('visible')) { hideContextMenu(); return; }
                var mention = document.getElementById('mentionDropdown');
                if (mention && mention.classList.contains('visible')) { hideMentionDropdown(); return; }
                // 가장 위 팝업 닫기
                var visible = openSlackPopups.filter(function(p) { return !p.minimized; });
                if (visible.length === 0) return;
                var top = visible[0];
                for (var i = 1; i < visible.length; i++) {
                    var currentZ = parseInt(visible[i].el.style.zIndex || 0);
                    var topZ = parseInt(top.el.style.zIndex || 0);
                    if (currentZ > topZ) top = visible[i];
                }
                closeSlackPopup(top.id);
            });
        } catch(e) {
            console.error('Slack 초기화 오류:', e);
        }
    };

    // ============================================================
    // 탭 전환
    // ============================================================
    function switchSlackTab(tab) {
        currentSlackTab = tab;
        var tabs = document.querySelectorAll('.slack-tab');
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].getAttribute('data-tab') === tab) tabs[i].classList.add('active');
            else tabs[i].classList.remove('active');
        }
        renderSlackChatList();
    }

    // ============================================================
    // 검색
    // ============================================================
    function handleSlackSearchInput() {
        var input = document.getElementById('slackSearchInput');
        if (!input) return;
        slackSearchQuery = (input.value || '').trim().toLowerCase();
        renderSlackChatList();
    }

    // ============================================================
    // 현재 탭의 데이터 가져오기
    // ============================================================
    function getCurrentTabData() {
        var src;
        if (currentSlackTab === 'friends') src = dummyFriends;
        else if (currentSlackTab === 'dm') src = dummyDMs;
        else if (currentSlackTab === 'channel') src = dummyChannels;
        else src = dummyCanvases;
        var q = slackSearchQuery;
        var filtered = q ? src.filter(function(item) {
            var n = (item.name || '').toLowerCase();
            var p = (item.preview || '').toLowerCase();
            if (n.indexOf(q) !== -1 || p.indexOf(q) !== -1) return true;
            if (item.members && Array.isArray(item.members)) {
                for (var i = 0; i < item.members.length; i++) {
                    if ((item.members[i] || '').toLowerCase().indexOf(q) !== -1) return true;
                }
            }
            if (item.participants && Array.isArray(item.participants)) {
                for (var j = 0; j < item.participants.length; j++) {
                    if ((item.participants[j] || '').toLowerCase().indexOf(q) !== -1) return true;
                }
            }
            return false;
        }) : src.slice();
        // [v2.4] "새 대화 시작하기" 기능 제거
        // 이유: DM 목록에 이미 있는 사람도 "새 대화"로 중복 표시되는 문제
        // 새 대화가 필요하면 Slack 앱에서 시작 → 자동으로 목록에 추가됨
        // [v3.0] 모든 탭 통일: 최근 업데이트 시간순 (안읽음 있으면 맨 위)
        filtered.sort(function(a, b) {
            // 안읽음 메시지가 있으면 우선
            var aUnread = (a.unread || 0) > 0 ? 1 : 0;
            var bUnread = (b.unread || 0) > 0 ? 1 : 0;
            if (aUnread !== bUnread) return bUnread - aUnread;
            // 최근 업데이트 시간순 (모든 탭 동일!)
            return (b.timeRaw || 0) - (a.timeRaw || 0);
        });
        return filtered;
    }

    // ============================================================
    // 채팅 목록 렌더링
    // ============================================================
    function renderSlackChatList() {
        var list = document.getElementById('slackChatList');
        if (!list) return;
        var items = getCurrentTabData();
        if (items.length === 0) {
            var emptyIcon = currentSlackTab === 'dm' ? '👥' : (currentSlackTab === 'channel' ? '#' : '📋');
            var emptyText = slackSearchQuery ? '검색 결과 없음' : '대화가 없습니다';
            list.innerHTML =
                '<div class="slack-chat-empty">' +
                    '<div class="slack-chat-empty-icon">' + emptyIcon + '</div>' +
                    '<div>' + emptyText + '</div>' +
                '</div>';
            return;
        }
        var html = '';
        items.forEach(function(item) {
            // [v0.3] 그룹 DM이면 겹침 아바타로 표시
            var avatarHtml = '';
            if (currentSlackTab === 'dm' && item.isGroup && item.members) {
                avatarHtml = buildGroupAvatarHtml(item.members);
            } else {
                var avatarClass = '';
                var avatarInner = firstCharOf(item.name);
                var avatarStyle = '';
                if (currentSlackTab === 'channel') {
                    avatarClass = ' channel-icon';
                    avatarInner = '#';
                } else if (currentSlackTab === 'canvas') {
                    avatarClass = ' canvas-icon';
                    avatarInner = '📋';
                } else {
                    avatarStyle = 'background:' + avatarColorFromName(item.name) + ';';
                }
                var onlineDot = (currentSlackTab === 'dm' && item.online)
                    ? '<span class="online-dot"></span>' : '';
                avatarHtml =
                    '<div class="slack-chat-avatar' + avatarClass + '" style="' + avatarStyle + '">' +
                        avatarInner +
                        onlineDot +
                    '</div>';
            }
            var unreadBadge = (item.unread && item.unread > 0)
                ? '<span class="slack-chat-unread">' + item.unread + '</span>' : '';
            var unreadClass = (item.unread && item.unread > 0) ? ' unread' : '';
            var safeName = highlightSearchTerm(escapeHtml(item.name), slackSearchQuery);
            var safePreview = highlightSearchTerm(escapeHtml(item.preview || ''), slackSearchQuery);
            var safeTime = escapeHtml(item.time || '');
            var safeId = String(item.id).replace(/'/g, "\\'");
            html +=
                '<div class="slack-chat-item' + unreadClass + '" onclick="openSlackChatPopup(\'' + currentSlackTab + '\', \'' + safeId + '\')">' +
                    avatarHtml +
                    '<div class="slack-chat-info">' +
                        '<div class="slack-chat-name-row">' +
                            '<div class="slack-chat-name">' + safeName + '</div>' +
                            '<div class="slack-chat-time">' + safeTime + '</div>' +
                        '</div>' +
                        '<div class="slack-chat-preview-row">' +
                            '<div class="slack-chat-preview">' + safePreview + '</div>' +
                            unreadBadge +
                        '</div>' +
                    '</div>' +
                '</div>';
        });
        list.innerHTML = html;
    }

    // [v0.5] 검색 매치 하이라이트
    function highlightSearchTerm(text, query) {
        if (!query || !text) return text;
        try {
            var re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
            return text.replace(re, '<span class="search-hl">$1</span>');
        } catch(e) { return text; }
    }

    // [v0.9] 소식 모달
    function openSlackUpdatesModal() {
        var modal = document.getElementById('slackUpdatesModal');
        var list = document.getElementById('slackUpdatesList');
        if (!modal || !list) return;
        if (typeof UPDATE_HISTORY === 'undefined') { showToast('업데이트 이력 없음'); return; }
        var html = '';
        UPDATE_HISTORY.forEach(function(up) {
            html +=
                '<div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:15px; margin-bottom:15px;">' +
                    '<div style="font-size:12px; color:#3b82f6; font-weight:bold; margin-bottom:5px;">' + escapeHtml(up.date) + ' (버전: ' + escapeHtml(up.version) + ')</div>' +
                    '<div style="font-size:16px; font-weight:800; color:#1e293b; margin-bottom:10px;">' + escapeHtml(up.title) + '</div>' +
                    '<ul style="margin-left:20px; font-size:14px; color:#475569; line-height:1.6;">' +
                        up.details.map(function(d) { return '<li style="margin-bottom:5px;">' + escapeHtml(d) + '</li>'; }).join('') +
                    '</ul>' +
                '</div>';
        });
        list.innerHTML = html;
        modal.style.display = 'flex';
    }

    // [v0.9] 로딩 중 스켈레톤 표시 (빈 화면 절대 금지! 안되면 춤이라도!)
    function showSlackLoadingSkeleton() {
        var list = document.getElementById('slackChatList');
        if (!list) return;
        var html = '<div class="slack-loading-emoji">💬</div>';
        for (var i = 0; i < 8; i++) {
            html +=
                '<div class="slack-skeleton-item">' +
                    '<div class="skeleton-avatar"></div>' +
                    '<div class="skeleton-lines">' +
                        '<div class="skeleton-line short"></div>' +
                        '<div class="skeleton-line long"></div>' +
                    '</div>' +
                '</div>';
        }
        list.innerHTML = html;
    }

    // [v0.7] 연동 안 된 사용자에게 연동 버튼 표시
    function showSlackConnectScreen() {
        var list = document.getElementById('slackChatList');
        if (!list) return;
        list.innerHTML =
            '<div style="text-align:center; padding:60px 20px;">' +
                '<div style="font-size:48px; margin-bottom:15px;">💬</div>' +
                '<h3 style="color:#1e293b; margin:0 0 8px;">Slack 연동이 필요합니다</h3>' +
                '<p style="color:#64748b; font-size:13px; line-height:1.6; margin-bottom:20px;">' +
                    '버튼 하나만 누르면 바로 연동돼요!<br>본인 Slack 계정으로 "허용"만 클릭하면 끝.' +
                '</p>' +
                '<button onclick="slackConnect()" style="padding:12px 28px; background:#4A154B; color:#fff; border:none; border-radius:10px; font-size:15px; font-weight:800; cursor:pointer; box-shadow:0 4px 14px rgba(74,21,75,0.35);">🔗 Slack 연동하기</button>' +
            '</div>';
        // 배너도 변경
        var banner = document.querySelector('.slack-demo-banner');
        if (banner) {
            banner.innerHTML = '🔗 Slack 연동 후 실제 대화를 확인할 수 있어요';
            banner.style.background = 'linear-gradient(90deg, #fbbf24, #f59e0b)';
        }
    }

    // ============================================================
    // [v0.6] 실제 Slack 데이터 로딩
    // ============================================================
    function loadRealSlackData() {
        // [v0.9] 빈 화면 대신 스켈레톤 유지 (이미 표시됨)
        var banner = document.querySelector('.slack-demo-banner');
        if (banner) {
            banner.innerHTML = '💬 대화 목록 불러오는 중...';
            banner.style.background = 'linear-gradient(90deg, #3b82f6, #60a5fa)';
            banner.style.color = '#ffffff';
        }
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) {
                    showToast('Slack 로딩 실패: ' + (res ? res.message : '오류'));
                    if (banner) banner.innerHTML = '⚠ Slack 연결 실패 — 더미 데이터 표시';
                    renderSlackChatList();
                    updateTabCounts();
                    return;
                }
                slackRealMode = true;
                slackUsersMap = res.usersMap || {};
                slackMyUserId = res.myUserId || '';
                dummyDMs = res.dms || [];
                dummyChannels = res.channels || [];
                dummyCanvases = res.canvases || [];
                dummyMessagesMap = {};
                if (banner) {
                    banner.innerHTML = '✅ Slack 연결됨 — 실제 데이터';
                    banner.style.background = 'linear-gradient(90deg, #22c55e, #16a34a)';
                    banner.style.color = '#ffffff';
                }
                renderSlackChatList();
                updateTabCounts();
                updateBrowserTitle();
                // [v2.6] 친구 목록 생성 (usersMap에서)
                dummyFriends = [];
                for (var fuid in slackUsersMap) {
                    if (!slackUsersMap.hasOwnProperty(fuid)) continue;
                    var fu = slackUsersMap[fuid];
                    if (fu.isBot) continue;
                    if (fuid === slackMyUserId) continue;
                    dummyFriends.push({
                        id: '__user_' + fuid,
                        userId: fuid,
                        name: fu.name || fuid,
                        preview: '',
                        time: '',
                        timeRaw: 0,
                        unread: 0,
                        online: false,
                        isGroup: false
                    });
                }
                showToast('Slack 연결! 친구 ' + dummyFriends.length + '명, 채팅 ' + dummyDMs.length + '개');
                // [v1.2] 연결 해제 버튼 표시
                var dcBtn = document.getElementById('slackDisconnectBtn');
                if (dcBtn) dcBtn.style.display = 'inline-block';
                // [v2.9] usersMap 캐시 (Delta 폴링에서 사용)
                google.script.run.cacheSlackUsersMap(slackMyUserId);
                // [v0.8] 백그라운드에서 미리보기 + 시간 로드 → 정렬
                loadPreviewsInBackground();
                // [v2.9] 스마트 폴링 시작 (포커스 1초 + 나머지 3초)
                startSlackPolling();
                // [v1.2] 캔버스 백그라운드 로드
                loadCanvasesInBackground();
            })
            .withFailureHandler(function(err) {
                showToast('Slack 연결 실패');
                renderSlackChatList();
                updateTabCounts();
            })
            .listSlackChannels();
    }

    function loadRealMessages(popupId, popupEl) {
        if (!slackRealMode) return;
        // [v3.0 fix] 이미 로드된 메시지가 있으면 스킵 (Delta가 처리)
        if (dummyMessagesMap[popupId] && dummyMessagesMap[popupId].length > 0) return;
        var body = popupEl.querySelector('.slack-popup-body');
        if (body) body.innerHTML = '<div style="color:#475569; text-align:center; padding:30px;">💬 메시지 불러오는 중...</div>';
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) {
                    // [v3.0 fix] 실패해도 빈 메시지로 초기화 (새 대화방일 수 있음)
                    dummyMessagesMap[popupId] = [];
                    if (body) body.innerHTML = '<div style="color:#94a3b8; text-align:center; padding:30px;">새 대화를 시작해보세요! 💬</div>';
                    return;
                }
                dummyMessagesMap[popupId] = res.messages || [];
                if (dummyMessagesMap[popupId].length === 0) {
                    if (body) body.innerHTML = '<div style="color:#94a3b8; text-align:center; padding:30px;">새 대화를 시작해보세요! 💬</div>';
                } else {
                    renderPopupMessages(popupEl, popupId);
                }
            })
            .withFailureHandler(function(err) {
                // [v3.0 fix] 서버 에러(타임아웃 등)도 빈 대화로 처리
                dummyMessagesMap[popupId] = [];
                if (body) body.innerHTML = '<div style="color:#94a3b8; text-align:center; padding:30px;">새 대화를 시작해보세요! 💬</div>';
            })
            .getSlackMessages(popupId, 30);
    }

    // ============================================================
    // [v0.8] 백그라운드 미리보기 로드 → 정렬
    // ============================================================
    function loadPreviewsInBackground() {
        if (!slackRealMode) return;
        // 모든 DM + 채널 ID 수집
        var allIds = [];
        dummyDMs.forEach(function(d) { allIds.push(d.id); });
        dummyChannels.forEach(function(c) { allIds.push(c.id); });
        if (allIds.length === 0) return;
        // 20개씩 배치로 나눠서 호출 (서버 부담 분산)
        var batches = [];
        for (var i = 0; i < allIds.length; i += 20) {
            batches.push(allIds.slice(i, i + 20));
        }
        var batchIdx = 0;
        function processBatch() {
            if (batchIdx >= batches.length) return;
            var batch = batches[batchIdx];
            batchIdx++;
            google.script.run
                .withSuccessHandler(function(res) {
                    if (!res || !res.success || !res.results) {
                        setTimeout(processBatch, 500);
                        return;
                    }
                    // DM에 미리보기 반영
                    dummyDMs.forEach(function(d) {
                        if (res.results[d.id]) {
                            d.preview = res.results[d.id].preview || d.preview;
                            d.time = res.results[d.id].time || d.time;
                            d.timeRaw = res.results[d.id].timeRaw || d.timeRaw;
                        }
                    });
                    // 채널에 미리보기 반영
                    dummyChannels.forEach(function(c) {
                        if (res.results[c.id]) {
                            c.preview = res.results[c.id].preview || c.preview;
                            c.time = res.results[c.id].time || c.time;
                            c.timeRaw = res.results[c.id].timeRaw || c.timeRaw;
                        }
                    });
                    // UI 갱신 (미리보기 + 정렬 반영)
                    renderSlackChatList();
                    // 다음 배치 (0.5초 뒤)
                    setTimeout(processBatch, 500);
                })
                .withFailureHandler(function() {
                    setTimeout(processBatch, 500);
                })
                .getLastMessagesBatch(JSON.stringify(batch));
        }
        // 1초 뒤 시작 (목록 렌더 완료 후)
        setTimeout(processBatch, 1000);
    }

    // [v1.2] 캔버스 백그라운드 로드
    function loadCanvasesInBackground() {
        if (!slackRealMode) return;
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) return;
                dummyCanvases = res.canvases || [];
                // 캔버스 탭이 활성이면 갱신
                if (currentSlackTab === 'canvas') renderSlackChatList();
                updateTabCounts();
            })
            .searchSlackCanvases();
    }

    // [v1.2] 캔버스 클릭 시 Slack 웹에서 열기
    function openCanvasInSlack(canvasId) {
        var canvas = dummyCanvases.find(function(c) { return c.id === canvasId; });
        if (canvas && canvas.url) {
            window.open(canvas.url, '_blank');
        } else {
            showToast('캔버스 링크를 찾을 수 없어요');
        }
    }

    // [v0.3] 그룹 아바타 HTML (2~3명 겹침 - 카톡 스타일)
    function buildGroupAvatarHtml(members) {
        if (!members || members.length === 0) return '<div class="slack-chat-avatar">?</div>';
        var show = members.slice(0, 3);
        var inner = '';
        show.forEach(function(name, idx) {
            var color = avatarColorFromName(name);
            var ch = firstCharOf(name);
            inner += '<div class="group-avatar-mini group-avatar-mini-' + idx + '" style="background:' + color + ';">' + ch + '</div>';
        });
        return '<div class="slack-chat-avatar group-avatar">' + inner + '</div>';
    }

    function updateTabCounts() {
        var dmCountEl = document.getElementById('slackTabCountDm');
        var chCountEl = document.getElementById('slackTabCountChannel');
        var cvCountEl = document.getElementById('slackTabCountCanvas');
        var dmUnread = dummyDMs.reduce(function(s, x) { return s + (x.unread || 0); }, 0);
        var chUnread = dummyChannels.reduce(function(s, x) { return s + (x.unread || 0); }, 0);
        var cvUnread = dummyCanvases.reduce(function(s, x) { return s + (x.unread || 0); }, 0);
        if (dmCountEl) { dmCountEl.textContent = dmUnread; dmCountEl.style.display = dmUnread > 0 ? '' : 'none'; }
        if (chCountEl) { chCountEl.textContent = chUnread; chCountEl.style.display = chUnread > 0 ? '' : 'none'; }
        if (cvCountEl) { cvCountEl.textContent = cvUnread; cvCountEl.style.display = cvUnread > 0 ? '' : 'none'; }
    }

    // ============================================================
    // 팝업 관리
    // ============================================================
    function findPopup(id) {
        for (var i = 0; i < openSlackPopups.length; i++) if (openSlackPopups[i].id === id) return openSlackPopups[i];
        return null;
    }

    function openSlackChatPopup(type, id) {
        // [v3.0 fix] 친구 탭 → conversations.open으로 DM 열기
        if (type === 'friends') {
            if (id.indexOf('__user_') === 0) {
                var friendUserId = id.replace('__user_', '');
                // 친구 이름 미리 저장 (팝업 생성 시 사용)
                var friendData = null;
                for (var fi = 0; fi < dummyFriends.length; fi++) {
                    if (dummyFriends[fi].id === id) { friendData = dummyFriends[fi]; break; }
                }
                window._pendingDmName = friendData ? friendData.name : friendUserId;
                showToast('대화방 열고 있어요...');
                google.script.run
                    .withSuccessHandler(function(res) {
                        if (res && res.success && res.channelId) {
                            openSlackChatPopup('dm', res.channelId);
                        } else {
                            window._pendingDmName = null;
                            showToast('대화방 열기 실패');
                        }
                    })
                    .withFailureHandler(function(err) {
                        window._pendingDmName = null;
                        showToast('대화방 열기 실패: ' + err);
                    })
                    .openSlackDm(friendUserId);
            }
            return;
        }
        // [v1.2] 캔버스 → Slack 웹에서 열기 (팝업 아님)
        if (type === 'canvas') {
            openCanvasInSlack(id);
            return;
        }
        // [v3.0 fix] 새 DM → conversations.open 후 팝업 열기
        if (id.indexOf('__user_') === 0) {
            var userId = id.replace('__user_', '');
            var uName = (slackUsersMap[userId] && slackUsersMap[userId].name) || userId;
            window._pendingDmName = uName;
            showToast('대화방 열고 있어요...');
            google.script.run
                .withSuccessHandler(function(res) {
                    if (res && res.success && res.channelId) {
                        openSlackChatPopup('dm', res.channelId);
                    } else {
                        window._pendingDmName = null;
                        showToast('대화방 열기 실패');
                    }
                })
                .withFailureHandler(function(err) {
                    window._pendingDmName = null;
                    showToast('대화방 열기 실패: ' + err);
                })
                .openSlackDm(userId);
            return;
        }
        var existing = findPopup(id);
        if (existing) {
            existing.minimized = false;
            existing.el.classList.remove('minimized');
            existing.el.style.zIndex = (++nextSlackPopupZ);
            renderDock();
            return;
        }
        if (openSlackPopups.length >= MAX_SLACK_POPUPS) {
            showToast('팝업은 최대 ' + MAX_SLACK_POPUPS + '개까지 열 수 있어요');
            return;
        }
        var data = getChatMetaById(type, id);
        // [v3.0 fix] dummyDMs에 없으면 새로 생성! (친구탭에서 새 대화 시작 시)
        if (!data) {
            var friendName = id;
            // usersMap에서 이름 찾기 (conversations.open이 반환한 channelId로)
            for (var uid in slackUsersMap) {
                if (!slackUsersMap.hasOwnProperty(uid)) continue;
                // DM 채널 목록에서 이 channelId가 있는지 확인 안 되니 friendName은 유지
            }
            // openSlackDm 호출 전에 저장한 이름 사용
            if (window._pendingDmName) {
                friendName = window._pendingDmName;
                window._pendingDmName = null;
            }
            data = {
                id: id, name: friendName,
                unread: 0, online: false, isGroup: false,
                preview: '', time: '', timeRaw: Date.now()
            };
            dummyDMs.push(data);
        }
        // 읽음 처리
        data.unread = 0;
        renderSlackChatList();
        updateTabCounts();
        // 팝업 DOM 생성
        var popupEl = buildPopupDom(type, id, data);
        document.getElementById('slackPopupContainer').appendChild(popupEl);
        // [v0.5] 초기 위치: 오른쪽에서 열림 (사용자 요청)
        var offset = openSlackPopups.length * 32;
        var rightPos = window.innerWidth - 360 - 40 - offset; // 360 popup width + 40 right margin
        if (rightPos < 560) rightPos = 560; // 메인 레이아웃(520+20 여유)과 겹치지 않게
        popupEl.style.left = rightPos + 'px';
        popupEl.style.top = (90 + offset) + 'px';
        popupEl.style.zIndex = (++nextSlackPopupZ);
        var popupState = {
            id: id, type: type, name: data.name, data: data,
            minimized: false, el: popupEl
        };
        openSlackPopups.push(popupState);
        makeSlackPopupDraggable(popupEl, id);
        setupPopupDragDrop(popupEl, id);
        // [v1.0] 클립보드 이미지 붙여넣기 감지
        setupPasteHandler(popupEl, id);
        // [v2.9] 포커스 추적 — 팝업 클릭 시 이 팝업이 "대화 중"
        popupEl.addEventListener('mousedown', function() { setFocusedPopup(id); });
        popupEl.addEventListener('focusin', function() { setFocusedPopup(id); });
        setFocusedPopup(id); // 열 때 바로 포커스
        // [v0.6] 실제 모드면 메시지 서버에서 로딩
        if (slackRealMode) {
            loadRealMessages(id, popupEl);
        }
        setTimeout(function() {
            var input = popupEl.querySelector('.slack-popup-input');
            if (input) input.focus();
            var body = popupEl.querySelector('.slack-popup-body');
            if (body) body.scrollTop = body.scrollHeight;
        }, 50);
        renderDock();
    }

    function getChatMetaById(type, id) {
        var src;
        if (type === 'dm') src = dummyDMs;
        else if (type === 'channel') src = dummyChannels;
        else src = dummyCanvases;
        for (var i = 0; i < src.length; i++) if (src[i].id === id) return src[i];
        return null;
    }

    function buildPopupDom(type, id, data) {
        var el = document.createElement('div');
        el.className = 'slack-popup';
        el.setAttribute('data-id', id);
        // [v0.3] 팝업 헤더 아바타 - 그룹 DM이면 겹침 아바타
        var headerAvatarHtml;
        var titlePrefix = '';
        if (type === 'dm' && data.isGroup && data.members) {
            headerAvatarHtml = buildGroupAvatarHtml(data.members).replace(
                /class="slack-chat-avatar group-avatar"/,
                'class="slack-popup-header-avatar group-avatar"'
            );
        } else {
            var avatarClass = '';
            var avatarInner = firstCharOf(data.name);
            var avatarStyle = '';
            if (type === 'channel') {
                avatarClass = ' channel-icon';
                avatarInner = '#';
                titlePrefix = '# ';
            } else if (type === 'canvas') {
                avatarClass = ' canvas-icon';
                avatarInner = '📋';
                titlePrefix = '📋 ';
            } else {
                avatarStyle = 'background:' + avatarColorFromName(data.name) + ';';
            }
            headerAvatarHtml =
                '<div class="slack-popup-header-avatar' + avatarClass + '" style="' + avatarStyle + '">' + avatarInner + '</div>';
        }
        var safeId = String(id).replace(/'/g, "\\'");
        var safeName = escapeHtml(data.name);
        // 그룹이면 "👥 (3명)" 부가 정보 헤더에 넣기
        var groupCount = '';
        if (type === 'dm' && data.isGroup && data.members) {
            groupCount = ' <span style="font-size:11px; font-weight:600; color:#475569; margin-left:4px;">(' + data.members.length + '명)</span>';
        }
        el.innerHTML =
            '<div class="slack-popup-header" id="slack-popup-hdr-' + id + '">' +
                headerAvatarHtml +
                '<div class="slack-popup-header-title">' + titlePrefix + safeName + groupCount + '</div>' +
                '<button class="slack-popup-header-btn" onclick="openInSlackApp(\'' + safeId + '\')" title="Slack 앱에서 열기">🔗</button>' +
                '<button class="slack-popup-header-btn" onclick="toggleMaximizePopup(\'' + safeId + '\')" title="크기 조절">🔲</button>' +
                '<button class="slack-popup-header-btn" onclick="minimizeSlackPopup(\'' + safeId + '\')" title="최소화">─</button>' +
                '<button class="slack-popup-header-btn" onclick="closeSlackPopup(\'' + safeId + '\')" title="닫기">✕</button>' +
            '</div>' +
            '<div class="slack-popup-body" id="slack-popup-body-' + id + '"></div>' +
            // [v1.0] 이미지 붙여넣기 프리뷰
            '<div class="slack-paste-preview" id="slack-paste-preview-' + id + '">' +
                '<img id="slack-paste-img-' + id + '" src="" alt="붙여넣기">' +
                '<div class="slack-paste-preview-info">캡처 이미지</div>' +
                '<button class="slack-paste-send" onclick="sendPastedImage(\'' + safeId + '\')">전송</button>' +
                '<button class="slack-paste-cancel" onclick="cancelPaste(\'' + safeId + '\')">취소</button>' +
            '</div>' +
            // [v0.4] 답장 미리보기 바 (답장 시작 시 표시)
            '<div class="slack-reply-preview" id="slack-reply-preview-' + id + '" style="display:none;">' +
                '<div class="slack-reply-preview-info">' +
                    '<div class="slack-reply-preview-from" id="slack-reply-preview-from-' + id + '"></div>' +
                    '<div class="slack-reply-preview-text" id="slack-reply-preview-text-' + id + '"></div>' +
                '</div>' +
                '<button class="slack-reply-cancel" onclick="cancelReply(\'' + safeId + '\')">✕</button>' +
            '</div>' +
            // [v0.4] 업로드 진행 바
            '<div class="slack-upload-progress" id="slack-upload-progress-' + id + '">' +
                '<span id="slack-upload-label-' + id + '">업로드 중...</span>' +
                '<div class="slack-upload-progress-bar"><div class="slack-upload-progress-fill" id="slack-upload-fill-' + id + '"></div></div>' +
            '</div>' +
            '<div class="slack-popup-input-area">' +
                // [v0.4] 파일 첨부 버튼
                '<button class="slack-popup-attach-btn" onclick="triggerFilePicker(\'' + safeId + '\')" title="파일 첨부">📎</button>' +
                '<input type="file" id="slack-file-input-' + id + '" style="display:none;" multiple onchange="handleFilePick(event, \'' + safeId + '\')">' +
                '<textarea class="slack-popup-input" rows="1" placeholder="메시지 입력..." onkeydown="handleSlackPopupInputKey(event, \'' + safeId + '\')"></textarea>' +
                '<button class="slack-popup-send" onclick="sendSlackPopupMessage(\'' + safeId + '\')">전송</button>' +
            '</div>';
        renderPopupMessages(el, id);
        el.addEventListener('mousedown', function() {
            el.style.zIndex = (++nextSlackPopupZ);
        });
        return el;
    }

    function renderPopupMessages(popupEl, id) {
        var body = popupEl.querySelector('.slack-popup-body');
        if (!body) return;
        var msgs = dummyMessagesMap[id] || [];
        if (msgs.length === 0) {
            body.innerHTML = '<div style="color:#475569; text-align:center; padding:30px; font-size:12px;">메시지를 입력해 대화를 시작해보세요.</div>';
            return;
        }
        // [v0.3] 그룹 채팅(그룹 DM/채널/캔버스)인지 판단 → 모든 말풍선에 이름 표시
        var p = findPopup(id);
        var isGroupChat = false;
        if (p) {
            if (p.type === 'channel' || p.type === 'canvas') isGroupChat = true;
            else if (p.type === 'dm' && p.data && p.data.isGroup) isGroupChat = true;
        }
        var html = '';
        var lastDate = null;
        msgs.forEach(function(m) {
            // [v0.5] 날짜 구분선
            var msgDate = m.ts ? new Date(parseFloat(m.ts) * 1000) : null;
            var dateKey = msgDate ? (msgDate.getFullYear() + '-' + msgDate.getMonth() + '-' + msgDate.getDate()) : null;
            if (dateKey && dateKey !== lastDate) {
                lastDate = dateKey;
                html += '<div class="msg-date-sep"><span>' + formatDateSep(msgDate) + '</span></div>';
            }
            // 삭제된 메시지
            if (m.deleted) {
                html +=
                    '<div class="msg-bubble-row' + (m.mine ? ' mine' : '') + '" data-msg-id="' + escapeHtml(m.id || '') + '">' +
                        '<div class="msg-avatar" style="background:#cbd5e1;">?</div>' +
                        '<div class="msg-bubble-col">' +
                            '<div class="msg-bubble-wrap">' +
                                '<div class="msg-bubble msg-deleted">삭제된 메시지입니다</div>' +
                            '</div>' +
                        '</div>' +
                    '</div>';
                return;
            }
            var mineClass = m.mine ? ' mine' : '';
            var avatarStyle = 'background:' + avatarColorFromName(m.from || '?') + ';';
            var safeFrom = escapeHtml(m.from || '');
            var safeText = highlightMentions(escapeHtml(m.text || ''));
            var safeTime = escapeHtml(m.time || '');
            var msgId = escapeHtml(m.id || '');
            var senderName = (!m.mine && (isGroupChat || !p)) ? '<div class="msg-sender-name">' + safeFrom + '</div>' : '';
            // 인용 박스
            var quoteBox = '';
            if (m.replyTo) {
                var qFrom = escapeHtml(m.replyTo.from || '');
                var qText = escapeHtml((m.replyTo.text || '').substring(0, 60));
                var qId = escapeHtml(m.replyTo.id || '');
                quoteBox =
                    '<div class="msg-quote-box" onclick="scrollToMessage(\'' + id + '\', \'' + qId + '\')">' +
                        '<div class="msg-quote-from">' + qFrom + '</div>' +
                        '<div class="msg-quote-text">' + qText + '</div>' +
                    '</div>';
            }
            // 수정됨 마커
            var editedMark = m.edited ? ' <span class="msg-edited">(수정됨)</span>' : '';
            // 말풍선 내용
            var bubbleContent;
            if (m.file) {
                bubbleContent = renderFileBubble(m.file);
            } else {
                bubbleContent = '<div class="msg-bubble">' + quoteBox + safeText + editedMark + '</div>';
            }
            // [v0.5] 리액션
            var reactionsHtml = '';
            if (m.reactions && m.reactions.length > 0) {
                reactionsHtml = '<div class="msg-reactions">';
                m.reactions.forEach(function(r) {
                    var isMine = r.users && r.users.indexOf(myUserName) !== -1;
                    reactionsHtml +=
                        '<div class="msg-reaction' + (isMine ? ' mine' : '') + '" onclick="toggleReaction(\'' + id + '\', \'' + msgId + '\', \'' + r.emoji + '\')">' +
                            '<span class="msg-reaction-emoji">' + r.emoji + '</span>' +
                            '<span class="msg-reaction-count">' + (r.users ? r.users.length : 0) + '</span>' +
                        '</div>';
                });
                reactionsHtml += '</div>';
            }
            // 읽음 표시 (내 메시지만)
            var readStatus = '';
            if (m.mine) {
                readStatus = '<span class="msg-read-status' + (m.read ? ' read' : '') + '">' + (m.read ? '읽음' : '1') + '</span>';
            }
            // 액션 버튼들 (호버 시 표시): 답장, 리액션, 더보기
            var textForReply = (m.text || (m.file ? '[파일]' : '')).substring(0, 60).replace(/'/g, '&apos;').replace(/"/g, '&quot;').replace(/\n/g, ' ');
            var replyBtn = '<button class="msg-reply-btn" onclick="event.stopPropagation(); startReply(\'' + id + '\', \'' + msgId + '\', \'' + safeFrom.replace(/'/g, '&apos;') + '\', \'' + textForReply + '\')">↩ 답장</button>';
            var reactionBtn = '<button class="msg-action-btn reaction-btn" onclick="event.stopPropagation(); openEmojiPicker(event, function(emoji) { toggleReaction(\'' + id + '\', \'' + msgId + '\', emoji); })">😀</button>';
            var moreBtn = '<button class="msg-action-btn more-btn" onclick="event.stopPropagation(); openMessageContextMenu(event, \'' + id + '\', \'' + msgId + '\')">⋯</button>';
            // 아바타 클릭 시 프로필 표시 (타인만)
            var avatarHtml = m.mine
                ? '<div class="msg-avatar" style="' + avatarStyle + '">' + firstCharOf(m.from) + '</div>'
                : '<div class="msg-avatar" style="' + avatarStyle + '; cursor:pointer;" onclick="event.stopPropagation(); showProfileModal(\'' + safeFrom.replace(/'/g, '&apos;') + '\')">' + firstCharOf(m.from) + '</div>';
            // [v3.0] 스레드 답글 표시
            var threadHtml = '';
            if (m.thread && m.thread.replyCount > 0) {
                var threadClass = m.thread.subscribed ? 'msg-thread-bar subscribed' : 'msg-thread-bar';
                var threadIcon = m.thread.subscribed ? '🔴' : '💬';
                var threadLabel = m.thread.subscribed
                    ? threadIcon + ' ' + m.thread.replyCount + '개의 새 답글'
                    : threadIcon + ' ' + m.thread.replyCount + '개의 답글';
                var threadUsers = m.thread.replyUsers ? m.thread.replyUsers.slice(0, 3).join(', ') : '';
                var safeTs = String(m.ts || '').replace(/'/g, '');
                threadHtml =
                    '<div class="' + threadClass + '" onclick="event.stopPropagation(); loadThreadReplies(\'' + id + '\', \'' + safeTs + '\', this)">' +
                        '<span class="msg-thread-label">' + threadLabel + '</span>' +
                        (threadUsers ? '<span class="msg-thread-users">' + escapeHtml(threadUsers) + '</span>' : '') +
                    '</div>' +
                    '<div class="msg-thread-replies" id="thread-' + safeTs.replace('.', '-') + '" style="display:none;"></div>';
            }
            html +=
                '<div class="msg-bubble-row' + mineClass + '" data-msg-id="' + msgId + '">' +
                    replyBtn +
                    reactionBtn +
                    moreBtn +
                    avatarHtml +
                    '<div class="msg-bubble-col">' +
                        senderName +
                        '<div class="msg-bubble-wrap">' +
                            '<div class="msg-time">' + readStatus + safeTime + '</div>' +
                            bubbleContent +
                        '</div>' +
                        reactionsHtml +
                        threadHtml +
                    '</div>' +
                '</div>';
        });
        // [v3.0] 내 스레드 알림 바 (맨 위)
        var threadAlertHtml = '';
        var subscribedThreads = msgs.filter(function(m) { return m.thread && m.thread.subscribed; });
        if (subscribedThreads.length > 0) {
            threadAlertHtml =
                '<div class="msg-thread-alert">' +
                    '⚡ 내 스레드에 새 답글 ' + subscribedThreads.length + '건 ' +
                    '<span class="msg-thread-alert-btn" onclick="scrollToFirstThread(\'' + id + '\')">바로가기</span>' +
                '</div>';
        }
        body.innerHTML = threadAlertHtml + html;
        body.scrollTop = body.scrollHeight;
    }

    // [v0.5] 날짜 구분선 포맷
    function formatDateSep(d) {
        if (!d) return '';
        var now = new Date();
        var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        var diff = Math.round((today - target) / (1000 * 60 * 60 * 24));
        if (diff === 0) return '오늘';
        if (diff === 1) return '어제';
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1); if (m.length < 2) m = '0' + m;
        var dd = String(d.getDate()); if (dd.length < 2) dd = '0' + dd;
        var days = ['일','월','화','수','목','금','토'];
        return y + '년 ' + m + '월 ' + dd + '일 (' + days[d.getDay()] + ')';
    }

    // [v0.5] 텍스트 내 @멘션을 하이라이트로 표시
    function highlightMentions(text) {
        if (!text) return '';
        return text.replace(/@(\S+)/g, '<span class="mention-inline">@$1</span>');
    }

    // [v0.4] 파일 말풍선 렌더
    function renderFileBubble(file) {
        if (!file) return '<div class="msg-bubble">[파일 없음]</div>';
        var sizeStr = formatFileSize(file.size || 0);
        var demoBadge = '<span class="msg-file-demo-badge">🚧 데모</span>';
        if (file.type === 'image') {
            var imgSrc = file.dataUrl || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180" viewBox="0 0 240 180"><rect fill="%23e2e8f0" width="240" height="180"/><text x="120" y="90" font-size="14" fill="%2394a3b8" text-anchor="middle" dominant-baseline="central">🖼 ' + escapeHtml(file.name || '') + '</text></svg>';
            return '<div class="msg-bubble" style="padding:6px;">' +
                '<div class="msg-file">' +
                    '<img class="msg-file-image" src="' + imgSrc + '" alt="' + escapeHtml(file.name || '') + '" onclick="openLightbox(\'' + encodeURIComponent(imgSrc) + '\')">' +
                    '<div class="msg-file-info">' +
                        '<div class="msg-file-name">' + escapeHtml(file.name || '') + '</div>' +
                        '<div class="msg-file-size">' + sizeStr + ' ' + demoBadge + '</div>' +
                    '</div>' +
                '</div>' +
            '</div>';
        }
        // 문서 파일
        var ext = (file.name || '').split('.').pop().toLowerCase();
        var iconClass = 'file-other';
        var iconChar = '📄';
        if (ext === 'pdf') { iconClass = 'file-pdf'; iconChar = 'PDF'; }
        else if (ext === 'doc' || ext === 'docx') { iconClass = 'file-doc'; iconChar = 'DOC'; }
        else if (ext === 'xls' || ext === 'xlsx') { iconClass = 'file-xls'; iconChar = 'XLS'; }
        else if (ext === 'ppt' || ext === 'pptx') { iconClass = 'file-ppt'; iconChar = 'PPT'; }
        else if (ext === 'zip' || ext === 'rar' || ext === '7z') { iconClass = 'file-zip'; iconChar = 'ZIP'; }
        return '<div class="msg-bubble" style="padding:0;">' +
            '<div class="msg-file-doc" onclick="showToast(\'(데모) 실제 다운로드는 OAuth 연동 후\')">' +
                '<div class="msg-file-icon ' + iconClass + '">' + iconChar + '</div>' +
                '<div class="msg-file-info">' +
                    '<div class="msg-file-name">' + escapeHtml(file.name || '') + '</div>' +
                    '<div class="msg-file-size">' + sizeStr + ' ' + demoBadge + '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    function formatFileSize(bytes) {
        if (!bytes) return '0B';
        if (bytes < 1024) return bytes + 'B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'KB';
        return (bytes / 1024 / 1024).toFixed(1) + 'MB';
    }

    // [v0.4] 이미지 라이트박스
    function openLightbox(encodedSrc) {
        var src = decodeURIComponent(encodedSrc);
        var lb = document.getElementById('slackLightbox');
        if (!lb) {
            lb = document.createElement('div');
            lb.id = 'slackLightbox';
            lb.className = 'slack-lightbox';
            lb.innerHTML = '<img id="slackLightboxImg" src="" alt="" />';
            lb.addEventListener('click', function() { lb.classList.remove('visible'); });
            document.body.appendChild(lb);
        }
        document.getElementById('slackLightboxImg').src = src;
        lb.classList.add('visible');
    }

    // [v0.4] 인용 클릭 → 원본 메시지로 스크롤 + 하이라이트
    function scrollToMessage(popupId, msgId) {
        var p = findPopup(popupId);
        if (!p) return;
        var row = p.el.querySelector('[data-msg-id="' + msgId + '"]');
        if (!row) { showToast('원본 메시지를 찾을 수 없어요'); return; }
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var bubble = row.querySelector('.msg-bubble');
        if (bubble) {
            bubble.classList.add('highlighted');
            setTimeout(function() { bubble.classList.remove('highlighted'); }, 2000);
        }
    }

    // 드래그 가능하게
    function makeSlackPopupDraggable(popupEl, id) {
        var header = popupEl.querySelector('.slack-popup-header');
        if (!header) return;
        var dragging = false, ox = 0, oy = 0;
        header.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            ox = e.clientX - parseInt(popupEl.style.left || 0);
            oy = e.clientY - parseInt(popupEl.style.top || 0);
            popupEl.style.zIndex = (++nextSlackPopupZ);
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!dragging) return;
            var nx = e.clientX - ox;
            var ny = e.clientY - oy;
            if (nx < 0) nx = 0;
            if (ny < 50) ny = 50;
            if (nx > window.innerWidth - 100) nx = window.innerWidth - 100;
            if (ny > window.innerHeight - 80) ny = window.innerHeight - 80;
            popupEl.style.left = nx + 'px';
            popupEl.style.top = ny + 'px';
        });
        document.addEventListener('mouseup', function() { dragging = false; });
    }

    function minimizeSlackPopup(id) {
        var p = findPopup(id);
        if (!p) return;
        p.minimized = true;
        p.el.classList.add('minimized');
        renderDock();
    }

    function restoreSlackPopup(id) {
        var p = findPopup(id);
        if (!p) return;
        p.minimized = false;
        p.el.classList.remove('minimized');
        p.el.style.zIndex = (++nextSlackPopupZ);
        // [v0.5] 복원하면서 읽음 처리
        popupUnreadMap[id] = 0;
        if (p.data) p.data.unread = 0;
        renderSlackChatList();
        updateTabCounts();
        updateBrowserTitle();
        renderDock();
        setTimeout(function() {
            var input = p.el.querySelector('.slack-popup-input');
            if (input) input.focus();
        }, 50);
    }

    function closeSlackPopup(id) {
        var p = findPopup(id);
        if (!p) return;
        if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
        openSlackPopups = openSlackPopups.filter(function(x) { return x.id !== id; });
        renderDock();
    }

    function renderDock() {
        var dock = document.getElementById('slackPopupDock');
        if (!dock) return;
        var minimized = openSlackPopups.filter(function(p) { return p.minimized; });
        if (minimized.length === 0) { dock.innerHTML = ''; return; }
        var html = '';
        minimized.forEach(function(p) {
            var prefix = p.type === 'channel' ? '#' : (p.type === 'canvas' ? '📋' : '👤');
            var safeId = String(p.id).replace(/'/g, "\\'");
            var safeName = escapeHtml(p.name);
            // [v0.5] 최소화 상태에서 받은 새 메시지 수
            var unread = popupUnreadMap[p.id] || 0;
            var hasNewClass = unread > 0 ? ' has-new' : '';
            var unreadBadge = unread > 0 ? '<span class="slack-dock-unread">' + unread + '</span>' : '';
            html +=
                '<div class="slack-dock-item' + hasNewClass + '" onclick="restoreSlackPopup(\'' + safeId + '\')">' +
                    '<span>' + prefix + '</span>' +
                    '<span class="dock-title">' + safeName + '</span>' +
                    unreadBadge +
                    '<button class="slack-dock-close" onclick="event.stopPropagation(); closeSlackPopup(\'' + safeId + '\')">✕</button>' +
                '</div>';
        });
        dock.innerHTML = html;
    }

    // ============================================================
    // 메시지 입력/전송
    // ============================================================
    function handleSlackPopupInputKey(e, id) {
        // [v0.5] @멘션 자동완성 체크
        if (e.key === '@' || e.key === 'Backspace' || (e.key.length === 1 && /\S/.test(e.key))) {
            setTimeout(function() {
                var p = findPopup(id);
                if (!p) return;
                var input = p.el.querySelector('.slack-popup-input');
                if (input) checkMentionTrigger(id, input);
            }, 10);
        }
        if (e.key === 'Escape') {
            hideMentionDropdown();
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            if (document.getElementById('mentionDropdown').classList.contains('visible')) {
                // 멘션 드롭다운 열려있으면 첫 항목 선택
                e.preventDefault();
                var firstItem = document.getElementById('mentionDropdown').querySelector('.mention-item');
                if (firstItem) firstItem.click();
                return;
            }
            e.preventDefault();
            sendSlackPopupMessage(id);
        }
    }

    function sendSlackPopupMessage(id) {
        var p = findPopup(id);
        if (!p) return;
        var input = p.el.querySelector('.slack-popup-input');
        if (!input) return;
        var text = (input.value || '').trim();
        if (!text) return;
        // 낙관적 UI - 즉시 메시지 추가
        var now = new Date();
        var hh = String(now.getHours()); if (hh.length < 2) hh = '0' + hh;
        var mm = String(now.getMinutes()); if (mm.length < 2) mm = '0' + mm;
        var newMsgId = 'm_new_' + Date.now();
        var newMsg = { id: newMsgId, from: '나', text: text, time: hh + ':' + mm, mine: true };
        // [v0.4] 답장 상태면 replyTo 포함
        if (p.replyingTo) {
            newMsg.replyTo = {
                id: p.replyingTo.msgId,
                from: p.replyingTo.from,
                text: p.replyingTo.text
            };
            p.replyingTo = null;
            hideReplyPreview(id);
        }
        if (!dummyMessagesMap[id]) dummyMessagesMap[id] = [];
        dummyMessagesMap[id].push(newMsg);
        if (p.data) {
            p.data.preview = '나: ' + text;
            p.data.time = hh + ':' + mm;
            p.data.timeRaw = now.getTime();
        }
        renderPopupMessages(p.el, id);
        renderSlackChatList();
        input.value = '';
        input.focus();
        // [v0.6] 실제 API 전송
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) {
                    showToast('전송 실패: ' + (res ? res.message : '오류'));
                } else if (slackRealMode) {
                    // [v2.9] 전송 성공 후 0.5초 뒤 Delta 폴링 (상대방 답장 빨리 받기!)
                    var sentTs = (res.ts || '0');
                    setTimeout(function() {
                        quickDeltaPoll(id, sentTs);
                    }, 500);
                    // 1.5초 후 한번 더 (답장이 빠른 경우)
                    setTimeout(function() {
                        quickDeltaPoll(id, sentTs);
                    }, 1500);
                }
            })
            .sendSlackMessage_v04(id, text, null);
        showToast(slackRealMode ? '전송됨' : '(데모) 메시지 추가됨');
    }

    // ============================================================
    // [v0.4] 답장(Reply) 기능
    // ============================================================
    function startReply(popupId, msgId, msgFrom, msgText) {
        var p = findPopup(popupId);
        if (!p) return;
        p.replyingTo = { msgId: msgId, from: msgFrom, text: msgText };
        showReplyPreview(popupId, msgFrom, msgText);
        var input = p.el.querySelector('.slack-popup-input');
        if (input) input.focus();
    }

    function cancelReply(popupId) {
        var p = findPopup(popupId);
        if (!p) return;
        p.replyingTo = null;
        hideReplyPreview(popupId);
    }

    function showReplyPreview(popupId, from, text) {
        var wrap = document.getElementById('slack-reply-preview-' + popupId);
        var fromEl = document.getElementById('slack-reply-preview-from-' + popupId);
        var textEl = document.getElementById('slack-reply-preview-text-' + popupId);
        if (wrap && fromEl && textEl) {
            fromEl.textContent = '↩ ' + from + '님에게 답장';
            textEl.textContent = text;
            wrap.style.display = 'flex';
        }
    }

    function hideReplyPreview(popupId) {
        var wrap = document.getElementById('slack-reply-preview-' + popupId);
        if (wrap) wrap.style.display = 'none';
    }

    // ============================================================
    // [v0.4] 파일 업로드 - Option C 방식
    // API-Ready: 서버 함수(getSlackUploadUrl, completeSlackUpload) 는
    //            OAuth 연동 후 내부만 교체. 클라이언트 코드 무변경.
    // ============================================================
    function triggerFilePicker(popupId) {
        var fi = document.getElementById('slack-file-input-' + popupId);
        if (fi) fi.click();
    }

    function handleFilePick(event, popupId) {
        var files = event.target.files;
        if (!files || files.length === 0) return;
        for (var i = 0; i < files.length; i++) {
            uploadFileToSlack(files[i], popupId);
        }
        event.target.value = ''; // 같은 파일 다시 선택 가능하도록
    }

    function setupPopupDragDrop(popupEl, popupId) {
        popupEl.addEventListener('dragenter', function(e) {
            e.preventDefault();
            popupEl.classList.add('drop-active');
        });
        popupEl.addEventListener('dragover', function(e) {
            e.preventDefault();
            popupEl.classList.add('drop-active');
        });
        popupEl.addEventListener('dragleave', function(e) {
            if (e.target === popupEl || !popupEl.contains(e.relatedTarget)) {
                popupEl.classList.remove('drop-active');
            }
        });
        popupEl.addEventListener('drop', function(e) {
            e.preventDefault();
            popupEl.classList.remove('drop-active');
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                for (var i = 0; i < e.dataTransfer.files.length; i++) {
                    uploadFileToSlack(e.dataTransfer.files[i], popupId);
                }
            }
        });
    }

    // ★ API-Ready: 이 함수는 OAuth 후에도 그대로 ★
    function uploadFileToSlack(file, popupId) {
        if (!file) return;
        var p = findPopup(popupId);
        if (!p) return;
        showUploadProgress(popupId, file.name, 0);
        // 1단계: 서버에 업로드 URL 요청
        google.script.run
            .withSuccessHandler(function(urlRes) {
                if (!urlRes || !urlRes.success) {
                    showToast('업로드 URL 실패: ' + (urlRes ? urlRes.message : '오류'));
                    hideUploadProgress(popupId);
                    return;
                }
                // 2단계: 더미/실제 분기
                if (urlRes.dummy) {
                    // 더미 모드: 업로드 시뮬레이션 (0.5초 진행 바)
                    simulateUpload(popupId, file, urlRes, function() {
                        completeUploadStep(popupId, file, urlRes);
                    });
                } else {
                    // 실제 모드: URL에 직접 업로드 (OAuth 후)
                    var xhr = new XMLHttpRequest();
                    xhr.open('POST', urlRes.upload_url, true);
                    xhr.upload.onprogress = function(e) {
                        if (e.lengthComputable) {
                            showUploadProgress(popupId, file.name, (e.loaded / e.total) * 100);
                        }
                    };
                    xhr.onload = function() {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            completeUploadStep(popupId, file, urlRes);
                        } else {
                            showToast('업로드 실패');
                            hideUploadProgress(popupId);
                        }
                    };
                    xhr.onerror = function() {
                        showToast('네트워크 오류');
                        hideUploadProgress(popupId);
                    };
                    xhr.send(file);
                }
            })
            .withFailureHandler(function() {
                showToast('서버 연결 실패');
                hideUploadProgress(popupId);
            })
            .getSlackUploadUrl(file.name, file.size, popupId);
    }

    function simulateUpload(popupId, file, urlRes, onDone) {
        var pct = 0;
        var interval = setInterval(function() {
            pct += 20;
            showUploadProgress(popupId, file.name, pct);
            if (pct >= 100) {
                clearInterval(interval);
                // 이미지 파일이면 dataUrl 읽기 (프리뷰용)
                if (file.type && file.type.indexOf('image/') === 0) {
                    var reader = new FileReader();
                    reader.onload = function(e) {
                        file._dataUrl = e.target.result;
                        onDone();
                    };
                    reader.readAsDataURL(file);
                } else {
                    onDone();
                }
            }
        }, 80);
    }

    function completeUploadStep(popupId, file, urlRes) {
        google.script.run
            .withSuccessHandler(function(doneRes) {
                hideUploadProgress(popupId);
                if (!doneRes || !doneRes.success) {
                    showToast('업로드 완료 실패: ' + (doneRes ? doneRes.message : '오류'));
                    return;
                }
                // 파일 메시지 추가
                addFileMessageToPopup(popupId, file, doneRes.file);
            })
            .withFailureHandler(function() {
                hideUploadProgress(popupId);
                showToast('완료 통보 실패');
            })
            .completeSlackUpload(urlRes.file_id, popupId, file.name);
    }

    function addFileMessageToPopup(popupId, file, serverFile) {
        var p = findPopup(popupId);
        if (!p) return;
        var now = new Date();
        var hh = String(now.getHours()); if (hh.length < 2) hh = '0' + hh;
        var mm = String(now.getMinutes()); if (mm.length < 2) mm = '0' + mm;
        var isImage = file.type && file.type.indexOf('image/') === 0;
        var newMsgId = 'm_file_' + Date.now();
        var fileMsg = {
            id: newMsgId,
            from: '나',
            mine: true,
            time: hh + ':' + mm,
            file: {
                type: isImage ? 'image' : (file.name.split('.').pop().toLowerCase()),
                name: file.name,
                size: file.size,
                dataUrl: file._dataUrl || null
            }
        };
        if (!dummyMessagesMap[popupId]) dummyMessagesMap[popupId] = [];
        dummyMessagesMap[popupId].push(fileMsg);
        if (p.data) {
            p.data.preview = '나: 📎 ' + file.name;
            p.data.time = hh + ':' + mm;
            p.data.timeRaw = now.getTime();
        }
        renderPopupMessages(p.el, popupId);
        renderSlackChatList();
        showToast('(데모) 파일 업로드 완료: ' + file.name);
    }

    function showUploadProgress(popupId, fileName, pct) {
        var wrap = document.getElementById('slack-upload-progress-' + popupId);
        var label = document.getElementById('slack-upload-label-' + popupId);
        var fill = document.getElementById('slack-upload-fill-' + popupId);
        if (!wrap || !label || !fill) return;
        wrap.classList.add('visible');
        label.textContent = '📎 ' + fileName + ' (' + Math.round(pct) + '%)';
        fill.style.width = pct + '%';
    }

    function hideUploadProgress(popupId) {
        var wrap = document.getElementById('slack-upload-progress-' + popupId);
        if (wrap) wrap.classList.remove('visible');
    }

    // ============================================================
    // [v0.5] 이모지 리액션
    // ============================================================
    function toggleReaction(popupId, msgId, emoji) {
        var msgs = dummyMessagesMap[popupId];
        if (!msgs) return;
        var m = msgs.find(function(x) { return x.id === msgId; });
        if (!m) return;
        if (!m.reactions) m.reactions = [];
        var existing = m.reactions.find(function(r) { return r.emoji === emoji; });
        var isMine;
        if (existing) {
            isMine = existing.users && existing.users.indexOf(myUserName) !== -1;
            if (isMine) {
                // 제거
                existing.users = existing.users.filter(function(u) { return u !== myUserName; });
                if (existing.users.length === 0) m.reactions = m.reactions.filter(function(r) { return r.emoji !== emoji; });
                google.script.run.withSuccessHandler(function(){}).removeSlackReaction(popupId, m.ts || '', emoji);
            } else {
                existing.users.push(myUserName);
                google.script.run.withSuccessHandler(function(){}).addSlackReaction(popupId, m.ts || '', emoji);
            }
        } else {
            m.reactions.push({ emoji: emoji, users: [myUserName] });
            google.script.run.withSuccessHandler(function(){}).addSlackReaction(popupId, m.ts || '', emoji);
        }
        var p = findPopup(popupId);
        if (p) renderPopupMessages(p.el, popupId);
    }

    // ============================================================
    // [v0.5] 이모지 피커
    // ============================================================
    function openEmojiPicker(ev, callback) {
        var picker = document.getElementById('emojiPicker');
        if (!picker) return;
        picker.innerHTML = '';
        EMOJI_PICKER_LIST.forEach(function(emoji) {
            var btn = document.createElement('button');
            btn.textContent = emoji;
            btn.addEventListener('click', function() {
                callback(emoji);
                picker.classList.remove('visible');
            });
            picker.appendChild(btn);
        });
        var rect = ev.target.getBoundingClientRect();
        picker.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
        picker.style.top = (rect.bottom + 6) + 'px';
        picker.classList.add('visible');
        emojiPickerCallback = callback;
        // 바깥 클릭 시 닫기
        setTimeout(function() {
            var onOut = function(e) {
                if (!picker.contains(e.target)) {
                    picker.classList.remove('visible');
                    document.removeEventListener('mousedown', onOut);
                }
            };
            document.addEventListener('mousedown', onOut);
        }, 50);
    }

    function openEmojiPickerForInput(popupId, ev) {
        openEmojiPicker(ev, function(emoji) {
            var p = findPopup(popupId);
            if (!p) return;
            var input = p.el.querySelector('.slack-popup-input');
            if (input) {
                input.value += emoji;
                input.focus();
            }
        });
    }

    // ============================================================
    // [v0.5] 메시지 컨텍스트 메뉴 (복사/전달/수정/삭제)
    // ============================================================
    function openMessageContextMenu(ev, popupId, msgId) {
        var menu = document.getElementById('msgContextMenu');
        if (!menu) return;
        var msgs = dummyMessagesMap[popupId];
        if (!msgs) return;
        var m = msgs.find(function(x) { return x.id === msgId; });
        if (!m) return;
        var isMine = m.mine;
        var html = '';
        html += '<button onclick="copyMessageText(\'' + popupId + '\', \'' + msgId + '\')">📋 복사</button>';
        html += '<button onclick="openForwardModal(\'' + popupId + '\', \'' + msgId + '\')">📨 전달</button>';
        if (isMine) {
            html += '<div class="menu-divider"></div>';
            html += '<button onclick="editMessagePrompt(\'' + popupId + '\', \'' + msgId + '\')">✏ 수정</button>';
            html += '<button class="danger" onclick="deleteMessage(\'' + popupId + '\', \'' + msgId + '\')">🗑 삭제</button>';
        }
        menu.innerHTML = html;
        var rect = ev.target.getBoundingClientRect();
        menu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
        menu.style.top = (rect.bottom + 6) + 'px';
        menu.classList.add('visible');
        setTimeout(function() {
            var onOut = function(e) {
                if (!menu.contains(e.target)) {
                    menu.classList.remove('visible');
                    document.removeEventListener('mousedown', onOut);
                }
            };
            document.addEventListener('mousedown', onOut);
        }, 50);
    }

    function hideContextMenu() {
        var menu = document.getElementById('msgContextMenu');
        if (menu) menu.classList.remove('visible');
    }

    function copyMessageText(popupId, msgId) {
        hideContextMenu();
        var msgs = dummyMessagesMap[popupId];
        if (!msgs) return;
        var m = msgs.find(function(x) { return x.id === msgId; });
        if (!m) return;
        var text = m.text || (m.file ? '[파일] ' + m.file.name : '');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
                showToast('복사됨');
            }, function() {
                showToast('복사 실패');
            });
        } else {
            var ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); showToast('복사됨'); } catch(e) { showToast('복사 실패'); }
            document.body.removeChild(ta);
        }
    }

    function editMessagePrompt(popupId, msgId) {
        hideContextMenu();
        var msgs = dummyMessagesMap[popupId];
        if (!msgs) return;
        var m = msgs.find(function(x) { return x.id === msgId; });
        if (!m || !m.mine) return;
        var newText = prompt('메시지 수정:', m.text || '');
        if (newText === null || newText.trim() === '') return;
        m.text = newText.trim();
        m.edited = true;
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) showToast('수정 실패');
            })
            .editSlackMessage(popupId, m.ts || '', newText.trim());
        var p = findPopup(popupId);
        if (p) renderPopupMessages(p.el, popupId);
        renderSlackChatList();
        showToast('수정됨');
    }

    function deleteMessage(popupId, msgId) {
        hideContextMenu();
        if (!confirm('이 메시지를 삭제할까요?')) return;
        var msgs = dummyMessagesMap[popupId];
        if (!msgs) return;
        var m = msgs.find(function(x) { return x.id === msgId; });
        if (!m || !m.mine) return;
        m.deleted = true;
        m.text = '';
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) showToast('삭제 실패');
            })
            .deleteSlackMessage(popupId, m.ts || '');
        var p = findPopup(popupId);
        if (p) renderPopupMessages(p.el, popupId);
        showToast('삭제됨');
    }

    // ============================================================
    // [v0.5] 메시지 전달
    // ============================================================
    var forwardingFrom = null; // { popupId, msgId }

    function openForwardModal(popupId, msgId) {
        hideContextMenu();
        forwardingFrom = { popupId: popupId, msgId: msgId };
        var modal = document.getElementById('slackForwardModal');
        var list = document.getElementById('slackForwardList');
        if (!modal || !list) return;
        // 전달 대상 목록: 모든 DM + 채널
        var html = '';
        dummyDMs.forEach(function(d) {
            if (d.id === popupId) return; // 원본 제외
            html += buildForwardTargetItem(d, 'dm');
        });
        dummyChannels.forEach(function(c) {
            if (c.id === popupId) return;
            html += buildForwardTargetItem(c, 'channel');
        });
        list.innerHTML = html;
        modal.classList.add('visible');
    }

    function buildForwardTargetItem(item, type) {
        var color = avatarColorFromName(item.name);
        var icon = type === 'channel' ? '#' : (item.isGroup ? '👥' : firstCharOf(item.name));
        var bg = type === 'channel' ? '#64748b' : color;
        var safeId = String(item.id).replace(/'/g, "\\'");
        return '<div class="slack-forward-target" onclick="executeForward(\'' + type + '\', \'' + safeId + '\')">' +
            '<div class="mention-item-avatar" style="background:' + bg + ';">' + icon + '</div>' +
            '<div>' + escapeHtml(item.name) + '</div>' +
        '</div>';
    }

    function closeForwardModal() {
        var modal = document.getElementById('slackForwardModal');
        if (modal) modal.classList.remove('visible');
        forwardingFrom = null;
    }

    function executeForward(targetType, targetId) {
        if (!forwardingFrom) { closeForwardModal(); return; }
        var srcMsgs = dummyMessagesMap[forwardingFrom.popupId];
        if (!srcMsgs) { closeForwardModal(); return; }
        var m = srcMsgs.find(function(x) { return x.id === forwardingFrom.msgId; });
        if (!m) { closeForwardModal(); return; }
        // 타겟에 새 메시지 추가 (전달 표시)
        if (!dummyMessagesMap[targetId]) dummyMessagesMap[targetId] = [];
        var now = new Date();
        var hh = String(now.getHours()); if (hh.length < 2) hh = '0' + hh;
        var mm = String(now.getMinutes()); if (mm.length < 2) mm = '0' + mm;
        var newText = '[전달] ' + (m.from || '') + ': ' + (m.text || (m.file ? m.file.name : ''));
        dummyMessagesMap[targetId].push({
            id: 'm_fwd_' + Date.now(),
            from: myUserName,
            text: newText,
            time: hh + ':' + mm,
            mine: true,
            ts: String(now.getTime() / 1000)
        });
        google.script.run
            .withSuccessHandler(function(){})
            .forwardSlackMessage(forwardingFrom.popupId, m.ts || '', targetId, m.text || '', m.from || '');
        showToast('전달됨');
        closeForwardModal();
        // 목록 갱신
        renderSlackChatList();
        // 대상 팝업 열려있으면 갱신
        var tp = findPopup(targetId);
        if (tp) renderPopupMessages(tp.el, targetId);
    }

    // ============================================================
    // [v0.5] 프로필 모달
    // ============================================================
    function showProfileModal(userName) {
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) return;
                renderProfileModal(res.profile, userName);
            })
            .getSlackUserProfile(userName);
    }

    function renderProfileModal(profile, fallbackName) {
        var modal = document.getElementById('slackProfileModal');
        var content = document.getElementById('slackProfileContent');
        if (!modal || !content) return;
        var name = profile.name || fallbackName;
        var color = avatarColorFromName(name);
        content.innerHTML =
            '<div class="profile-big-avatar" style="background:' + color + ';">' + firstCharOf(name) + '</div>' +
            '<div class="profile-name">' + escapeHtml(name) + '</div>' +
            '<div class="profile-title">' + escapeHtml(profile.title || '') + '</div>' +
            '<div class="profile-row"><span class="label">이메일</span><span class="value">' + escapeHtml(profile.email || '') + '</span></div>' +
            '<div class="profile-row"><span class="label">상태</span><span class="value">' + escapeHtml(profile.status || '') + '</span></div>' +
            '<div class="profile-row"><span class="label">연락처</span><span class="value">' + escapeHtml(profile.phone || '') + '</span></div>' +
            '<button class="profile-close-btn" onclick="closeProfileModal()">닫기</button>';
        modal.classList.add('visible');
    }

    function closeProfileModal() {
        var modal = document.getElementById('slackProfileModal');
        if (modal) modal.classList.remove('visible');
    }

    // ============================================================
    // [v0.5] @멘션 자동완성
    // ============================================================
    function checkMentionTrigger(popupId, input) {
        var val = input.value;
        var caret = input.selectionStart;
        // 커서 직전 @로 시작하는 단어 찾기
        var before = val.substring(0, caret);
        var match = before.match(/@([^\s@]*)$/);
        if (!match) {
            hideMentionDropdown();
            return;
        }
        var query = match[1].toLowerCase();
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) return;
                var filtered = res.members.filter(function(mb) {
                    return !query || mb.name.toLowerCase().indexOf(query) !== -1;
                });
                if (filtered.length === 0) { hideMentionDropdown(); return; }
                showMentionDropdown(popupId, input, filtered, match[0]);
            })
            .getSlackChannelMembers(popupId);
    }

    function showMentionDropdown(popupId, inputEl, members, trigger) {
        var dd = document.getElementById('mentionDropdown');
        if (!dd) return;
        var html = '';
        members.slice(0, 8).forEach(function(mb) {
            var color = avatarColorFromName(mb.name);
            html +=
                '<div class="mention-item" onclick="insertMention(\'' + popupId + '\', \'' + String(mb.name).replace(/'/g, "\\'") + '\')">' +
                    '<div class="mention-item-avatar" style="background:' + color + ';">' + firstCharOf(mb.name) + '</div>' +
                    '<div>' + escapeHtml(mb.name) + '</div>' +
                '</div>';
        });
        dd.innerHTML = html;
        var rect = inputEl.getBoundingClientRect();
        dd.style.left = rect.left + 'px';
        dd.style.top = (rect.top - 250) + 'px';
        dd.classList.add('visible');
        activeMentionState = { popupId: popupId, trigger: trigger, inputEl: inputEl };
    }

    function hideMentionDropdown() {
        var dd = document.getElementById('mentionDropdown');
        if (dd) dd.classList.remove('visible');
        activeMentionState = null;
    }

    function insertMention(popupId, name) {
        if (!activeMentionState) { hideMentionDropdown(); return; }
        var input = activeMentionState.inputEl;
        var val = input.value;
        var caret = input.selectionStart;
        var before = val.substring(0, caret);
        var after = val.substring(caret);
        var newBefore = before.replace(/@[^\s@]*$/, '@' + name + ' ');
        input.value = newBefore + after;
        var newCaret = newBefore.length;
        input.focus();
        input.setSelectionRange(newCaret, newCaret);
        hideMentionDropdown();
    }

    // ============================================================
    // [v0.5] 새 메시지 알림 (최소화/비활성 상태)
    // ============================================================
    function addMessageToChat(popupId, msgData, opts) {
        opts = opts || {};
        if (!dummyMessagesMap[popupId]) dummyMessagesMap[popupId] = [];
        dummyMessagesMap[popupId].push(msgData);
        // 메타데이터 업데이트
        var metas = [dummyDMs, dummyChannels, dummyCanvases];
        var meta = null;
        for (var i = 0; i < metas.length; i++) {
            meta = metas[i].find(function(x) { return x.id === popupId; });
            if (meta) break;
        }
        if (meta) {
            meta.preview = (msgData.from || '') + ': ' + (msgData.text || (msgData.file ? '[파일]' : ''));
            meta.time = msgData.time;
            meta.timeRaw = Date.now();
            // 팝업 열려있고 최소화 안 됐으면 읽음
            var p = findPopup(popupId);
            var isActiveView = p && !p.minimized;
            if (!isActiveView) {
                meta.unread = (meta.unread || 0) + 1;
                popupUnreadMap[popupId] = (popupUnreadMap[popupId] || 0) + 1;
            }
        }
        // 팝업 열려있으면 메시지 영역 갱신
        var p2 = findPopup(popupId);
        if (p2) renderPopupMessages(p2.el, popupId);
        // 목록 갱신 + 탭 카운트
        renderSlackChatList();
        updateTabCounts();
        renderDock();
        updateBrowserTitle();
        // [v1.0] 3종 알림: 데스크톱 + 탭 깜빡임 + 소리
        if (opts.notify && meta) {
            showDesktopNotification(meta.name, msgData.from + ': ' + (msgData.text || '[파일]'));
            startTabFlash(msgData.from, msgData.text || '[파일]');
            try { playSlackDing(); } catch(e) {}
        }
    }

    function updateBrowserTitle() {
        var totalUnread = 0;
        dummyDMs.forEach(function(x) { totalUnread += (x.unread || 0); });
        dummyChannels.forEach(function(x) { totalUnread += (x.unread || 0); });
        dummyCanvases.forEach(function(x) { totalUnread += (x.unread || 0); });
        document.title = (totalUnread > 0 ? '(' + totalUnread + ') ' : '') + '💬 개인대시보드 Slack';
    }

    function showDesktopNotification(title, body) {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission === 'granted') {
            try {
                var n = new Notification('💬 ' + title, {
                    body: body,
                    icon: '',
                    tag: 'slack-msg',  // 같은 tag → 기존 알림 교체 (쌓이지 않음)
                    requireInteraction: true,  // [v3.0] 직접 닫을 때까지 유지! (작업표시줄에도 표시)
                    silent: false
                });
                // 알림 클릭 시 탭으로 이동 + 깜빡임 멈춤
                n.onclick = function() {
                    window.focus();
                    stopTabFlash();
                    n.close();
                };
            } catch(e) {}
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission();
        }
    }

    // ============================================================
    // [v0.6] Slack 진단 — 오류신고에 전부 기록
    // ============================================================
    function runSlackDiagnostics() {
        showToast('진단 중...');
        google.script.run
            .withSuccessHandler(function(res) {
                var lines = [];
                lines.push('=== Slack 진단 v3.0 ===');
                lines.push('시각: ' + new Date().toLocaleString());
                lines.push('버전: Slack v3.0');
                lines.push('');

                // 토큰 상태
                lines.push('[토큰 상태]');
                lines.push('  토큰 존재: ' + (res.tokenExists ? 'YES' : 'NO'));
                lines.push('  토큰 앞부분: ' + (res.tokenPrefix || 'none'));
                lines.push('  토큰 길이: ' + (res.tokenLength || 0));
                lines.push('  토큰 소스: ' + (res.tokenSource || 'unknown'));
                lines.push('');

                // auth
                lines.push('[auth.test]');
                if (res.auth) {
                    lines.push('  ok: ' + res.auth.ok);
                    if (res.auth.ok) {
                        lines.push('  user: ' + (res.auth.user || ''));
                        lines.push('  user_id: ' + (res.auth.user_id || ''));
                        lines.push('  team: ' + (res.auth.team || ''));
                        lines.push('  team_id: ' + (res.auth.team_id || ''));
                    } else {
                        lines.push('  error: ' + (res.auth.error || 'unknown'));
                    }
                } else {
                    lines.push('  실행 안 됨 (토큰 없음)');
                }
                lines.push('');

                // OAuth2 상태
                lines.push('[OAuth2 서비스]');
                lines.push('  hasAccess: ' + (res.oauthHasAccess || false));
                lines.push('  oauth2.slack 키 존재: ' + (res.oauthKeyExists || false));
                lines.push('');

                // conversations
                if (res.byType) {
                    lines.push('[conversations.list 타입별]');
                    for (var t in res.byType) {
                        var d = res.byType[t];
                        lines.push('  ' + t + ': ok=' + d.ok + ' count=' + (d.count || 0) + (d.error ? ' error=' + d.error : ''));
                    }
                    lines.push('');
                }

                // 클라이언트 상태 (대폭 확대)
                lines.push('[클라이언트 상태]');
                lines.push('  realMode: ' + slackRealMode);
                lines.push('  myUserId: ' + slackMyUserId);
                lines.push('  DMs: ' + dummyDMs.length);
                lines.push('  channels: ' + dummyChannels.length);
                lines.push('  canvases: ' + dummyCanvases.length);
                lines.push('  friends: ' + dummyFriends.length);
                lines.push('  openPopups: ' + openSlackPopups.length);
                lines.push('  focusedPopup: ' + (focusedPopupId || 'none'));
                lines.push('  currentTab: ' + currentSlackTab);
                lines.push('  searchQuery: "' + slackSearchQuery + '"');
                lines.push('');

                // 열린 팝업 상세
                if (openSlackPopups.length > 0) {
                    lines.push('[열린 팝업 상세]');
                    openSlackPopups.forEach(function(p, i) {
                        var msgCount = (dummyMessagesMap[p.id] || []).length;
                        var lastTs = '';
                        if (msgCount > 0) {
                            var lastMsg = dummyMessagesMap[p.id][msgCount - 1];
                            lastTs = lastMsg.ts || '';
                        }
                        lines.push('  [' + i + '] id=' + p.id + ' name="' + p.name + '" type=' + p.type + ' minimized=' + p.minimized + ' msgs=' + msgCount + ' lastTs=' + lastTs);
                    });
                    lines.push('');
                }

                // 폴링 상태
                lines.push('[폴링 상태]');
                lines.push('  deltaInterval: ' + (slackDeltaInterval ? 'active(1s)' : 'off'));
                lines.push('  cacheInterval: ' + (slackCacheInterval ? 'active(3s)' : 'off'));
                lines.push('  lastListRefresh: ' + (window._lastListRefresh ? new Date(window._lastListRefresh).toLocaleTimeString() : 'never'));
                lines.push('');

                // usersMap 상태
                lines.push('[usersMap]');
                var umKeys = Object.keys(slackUsersMap);
                lines.push('  총 유저 수: ' + umKeys.length);
                lines.push('  봇 제외 유저: ' + umKeys.filter(function(k) { return !(slackUsersMap[k] && slackUsersMap[k].isBot); }).length);
                lines.push('');

                // DM 검색 테스트
                lines.push('[DM에서 "신현식" 검색]');
                var foundShin = dummyDMs.filter(function(d) {
                    return (d.name || '').indexOf('신현식') !== -1;
                });
                if (foundShin.length > 0) {
                    foundShin.forEach(function(d, i) {
                        lines.push('  찾음! [' + i + '] id=' + d.id + ' name="' + d.name + '" group=' + (d.isGroup || false));
                    });
                } else {
                    lines.push('  ❌ "신현식" 없음');
                }
                lines.push('');

                // DM 이름 샘플
                lines.push('[DM 이름 샘플]');
                lines.push('  처음 5개:');
                dummyDMs.slice(0, 5).forEach(function(d, i) {
                    lines.push('    [' + i + '] id=' + d.id + ' name="' + (d.name || '') + '" unread=' + (d.unread || 0));
                });
                lines.push('  마지막 5개:');
                dummyDMs.slice(-5).forEach(function(d, i) {
                    var idx = dummyDMs.length - 5 + i;
                    lines.push('    [' + idx + '] id=' + dummyDMs[idx].id + ' name="' + (dummyDMs[idx].name || '') + '" unread=' + (dummyDMs[idx].unread || 0));
                });
                lines.push('');

                // 채널 샘플
                lines.push('[채널 샘플 (처음 10개)]');
                dummyChannels.slice(0, 10).forEach(function(c, i) {
                    lines.push('  [' + i + '] id=' + c.id + ' name="' + (c.name || '') + '" unread=' + (c.unread || 0));
                });
                lines.push('');

                // 메시지맵 상태
                lines.push('[메시지맵 (dummyMessagesMap)]');
                var mmKeys = Object.keys(dummyMessagesMap);
                lines.push('  캐시된 채널 수: ' + mmKeys.length);
                mmKeys.forEach(function(k) {
                    lines.push('  ' + k + ': ' + (dummyMessagesMap[k] || []).length + '개');
                });
                lines.push('');

                // 오류 수집기
                if (typeof window.__errorCollector !== 'undefined' && window.__errorCollector.length > 0) {
                    lines.push('[수집된 오류 ' + window.__errorCollector.length + '건]');
                    window.__errorCollector.forEach(function(e, i) {
                        lines.push('  [' + i + '] ' + (e.type || '') + ': ' + String(e.message || '').substring(0, 150));
                        if (e.source) lines.push('    source: ' + e.source + ':' + (e.line || 0));
                        if (e.stack) lines.push('    stack: ' + String(e.stack).substring(0, 200));
                    });
                    lines.push('');
                } else {
                    lines.push('[수집된 오류] 없음 ✅');
                    lines.push('');
                }

                // 브라우저 정보
                lines.push('[환경]');
                lines.push('  URL: ' + (location.href || '').substring(0, 80));
                lines.push('  화면: ' + window.innerWidth + 'x' + window.innerHeight);
                lines.push('');

                lines.push('=== 끝 ===');
                var fullText = lines.join('\n');
                console.log(fullText);

                // [v3.0 fix] 클립보드 복사 — execCommand만 사용 (iframe에서 navigator.clipboard 안됨!)
                var copied = false;
                try {
                    var ta = document.createElement('textarea');
                    ta.value = fullText;
                    ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;';
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    copied = document.execCommand('copy');
                    document.body.removeChild(ta);
                } catch(e) {}
                showToast(copied ? '✅ 진단 결과 클립보드 복사 완료!' : '진단 완료 (팝업에서 Ctrl+A → Ctrl+C)');
                // 복사 실패 시에만 팝업 표시
                if (!copied) showDiagnosticResult(fullText);
            })
            .withFailureHandler(function(err) {
                showToast('진단 실패: ' + String(err));
            })
            .debugSlackApi();
    }

    // [v2.0] 진단 결과를 텍스트박스 팝업으로 — Ctrl+A → Ctrl+C 가능!
    function showDiagnosticResult(text) {
        var existing = document.getElementById('diagResultOverlay');
        if (existing) existing.remove();
        var overlay = document.createElement('div');
        overlay.id = 'diagResultOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px;';
        overlay.innerHTML =
            '<div style="background:#fff;border-radius:12px;padding:20px;max-width:600px;width:100%;max-height:80vh;display:flex;flex-direction:column;">' +
                '<h3 style="margin:0 0 10px;color:#1e293b;">🔍 진단 결과</h3>' +
                '<p style="font-size:12px;color:#64748b;margin:0 0 10px;">아래 텍스트를 <strong>Ctrl+A → Ctrl+C</strong> 로 복사해주세요</p>' +
                '<textarea id="diagResultText" style="flex:1;min-height:300px;padding:12px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;font-family:monospace;resize:none;color:#1e293b;" readonly>' + text + '</textarea>' +
                '<button onclick="document.getElementById(\'diagResultOverlay\').remove()" style="margin-top:10px;padding:8px 20px;background:#e2e8f0;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">닫기</button>' +
            '</div>';
        overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
        // 텍스트 자동 선택
        setTimeout(function() {
            var ta = document.getElementById('diagResultText');
            if (ta) { ta.focus(); ta.select(); }
        }, 100);
    }

    // 페이지 로드 시 자동 진단 (실제 모드일 때)
    function autoRunDiagnostics() {
        setTimeout(function() {
            runSlackDiagnostics();
        }, 3000);
    }

    // ============================================================
    // [v1.0] 새 메시지 알림 — 탭 깜빡임 + 작업표시줄 깜빡임 + 소리
    // ============================================================
    var tabFlashInterval = null;
    var tabFlashOriginalTitle = '';

    // ============================================================
    // [v3.0] 강력한 탭 깜빡임 — 읽을 때까지 계속!
    // ============================================================
    var tabFlashCount = 0;           // 안 읽은 알림 수
    var tabFlashMessages = [];       // 알림 메시지 큐

    function startTabFlash(senderName, text) {
        // [v3.0] 포커스 여부 관계없이 카운트 증가 + 알림 큐 추가
        tabFlashCount++;
        var preview = (senderName ? senderName + ': ' : '') + (text || '새 메시지').substring(0, 30);
        tabFlashMessages.push(preview);
        if (tabFlashMessages.length > 5) tabFlashMessages.shift(); // 최대 5개

        // 탭이 활성 상태면 소리만 + 데스크톱 알림
        if (document.hasFocus()) {
            try { playSlackDing(); } catch(e) {}
            showDesktopNotification(senderName || '새 메시지', text || '');
            // 포커스 상태에서는 카운트 바로 리셋
            tabFlashCount = 0;
            tabFlashMessages = [];
            return;
        }

        // 비활성 → 강력한 깜빡임 시작!
        if (!tabFlashOriginalTitle) {
            tabFlashOriginalTitle = document.title;
        }

        // 기존 인터벌 있으면 유지 (카운트만 증가)
        if (tabFlashInterval) return;

        var flashPhase = 0;
        tabFlashInterval = setInterval(function() {
            flashPhase = (flashPhase + 1) % 4;
            var latestMsg = tabFlashMessages.length > 0 ? tabFlashMessages[tabFlashMessages.length - 1] : '새 메시지';
            switch(flashPhase) {
                case 0: document.title = '🔴 [' + tabFlashCount + '개] ' + latestMsg; break;
                case 1: document.title = '⚡ [' + tabFlashCount + '개] 새 메시지!'; break;
                case 2: document.title = '🔴 [' + tabFlashCount + '개] ' + latestMsg; break;
                case 3: document.title = '💬 확인해주세요!'; break;
            }
        }, 500); // 0.5초마다 깜빡 (더 빠르게!)

        // 데스크톱 알림
        showDesktopNotification(senderName || '새 메시지', text || '');
        // 소리 (2초 간격으로 반복 3회)
        try { playSlackDing(); } catch(e) {}
        setTimeout(function() { try { playSlackDing(); } catch(e) {} }, 2000);
        setTimeout(function() { try { playSlackDing(); } catch(e) {} }, 4000);
    }

    function stopTabFlash() {
        if (tabFlashInterval) {
            clearInterval(tabFlashInterval);
            tabFlashInterval = null;
        }
        if (tabFlashOriginalTitle) {
            document.title = tabFlashOriginalTitle;
            tabFlashOriginalTitle = '';
        }
        tabFlashCount = 0;
        tabFlashMessages = [];
    }

    // 탭 포커스 돌아오면 깜빡임 멈춤
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) stopTabFlash();
    });
    window.addEventListener('focus', function() { stopTabFlash(); });

    // [v3.0] 알림 테스트 버튼
    function testSlackNotification() {
        // 테스트를 위해 임시로 포커스 해제 시뮬레이션
        var origHasFocus = document.hasFocus;
        document.hasFocus = function() { return false; };

        startTabFlash('박기찬', '테스트 메시지입니다! 🔔');

        // 2초 후 두 번째 알림 (카운트 증가 테스트)
        setTimeout(function() {
            startTabFlash('김철수', '두 번째 메시지!');
        }, 2000);

        // 원래 hasFocus 복원
        setTimeout(function() {
            document.hasFocus = origHasFocus;
        }, 100);

        showToast('🔔 알림 테스트! 다른 탭으로 전환해보세요 → 탭이 깜빡여요');
    }

    // addMessageToChat에서 알림 호출하도록 수정은 이미 있음.
    // 추가: startTabFlash 호출

    // ============================================================
    // [v1.0] 팝업 확대/축소 토글
    // ============================================================
    function toggleMaximizePopup(popupId) {
        var p = findPopup(popupId);
        if (!p) return;
        if (p.el.classList.contains('maximized')) {
            // 축소 → 원래 크기/위치 복원
            p.el.classList.remove('maximized');
            if (p.savedPos) {
                p.el.style.left = p.savedPos.left;
                p.el.style.top = p.savedPos.top;
                p.el.style.width = p.savedPos.width;
                p.el.style.height = p.savedPos.height;
            }
        } else {
            // 확대 → 현재 위치 저장 후 전체 크기
            p.savedPos = {
                left: p.el.style.left,
                top: p.el.style.top,
                width: p.el.style.width || '360px',
                height: p.el.style.height || '520px'
            };
            p.el.classList.add('maximized');
        }
        // 스크롤 맨 아래로
        setTimeout(function() {
            var body = p.el.querySelector('.slack-popup-body');
            if (body) body.scrollTop = body.scrollHeight;
        }, 100);
    }

    // ============================================================
    // [v1.0] 클립보드 이미지 붙여넣기 (Ctrl+V → 캡처 전송)
    // ============================================================
    var pendingPasteData = {}; // { popupId: { blob, dataUrl } }

    function setupPasteHandler(popupEl, popupId) {
        popupEl.addEventListener('paste', function(e) {
            if (!e.clipboardData || !e.clipboardData.items) return;
            for (var i = 0; i < e.clipboardData.items.length; i++) {
                var item = e.clipboardData.items[i];
                if (item.type && item.type.indexOf('image/') === 0) {
                    e.preventDefault();
                    var blob = item.getAsFile();
                    if (!blob) continue;
                    var reader = new FileReader();
                    reader.onload = function(ev) {
                        showPastePreview(popupId, blob, ev.target.result);
                    };
                    reader.readAsDataURL(blob);
                    return;
                }
            }
        });
    }

    function showPastePreview(popupId, blob, dataUrl) {
        pendingPasteData[popupId] = { blob: blob, dataUrl: dataUrl };
        var preview = document.getElementById('slack-paste-preview-' + popupId);
        var img = document.getElementById('slack-paste-img-' + popupId);
        if (preview && img) {
            img.src = dataUrl;
            preview.classList.add('visible');
        }
    }

    function cancelPaste(popupId) {
        delete pendingPasteData[popupId];
        var preview = document.getElementById('slack-paste-preview-' + popupId);
        if (preview) preview.classList.remove('visible');
    }

    function sendPastedImage(popupId) {
        var data = pendingPasteData[popupId];
        if (!data) return;
        cancelPaste(popupId); // 프리뷰 닫기
        // 파일 이름 생성
        var now = new Date();
        var fileName = 'capture_' + now.getFullYear() +
            String(now.getMonth()+1).padStart(2,'0') +
            String(now.getDate()).padStart(2,'0') + '_' +
            String(now.getHours()).padStart(2,'0') +
            String(now.getMinutes()).padStart(2,'0') +
            String(now.getSeconds()).padStart(2,'0') + '.png';
        // File 객체 생성
        var file = new File([data.blob], fileName, { type: 'image/png' });
        file._dataUrl = data.dataUrl;
        // 기존 업로드 함수 재사용!
        uploadFileToSlack(file, popupId);
    }

    // ============================================================
    // [v1.0 fix] 실시간 폴링 — 15초마다 새 메시지 확인
    // ============================================================
    var slackPollInterval = null;

    // ============================================================
    // [v2.9] 스마트 폴링 — 포커스 팝업은 1초 Delta, 나머지는 3초
    // ============================================================
    function startSlackPolling() {
        if (slackPollInterval) clearInterval(slackPollInterval);
        if (slackDeltaInterval) clearInterval(slackDeltaInterval);
        if (slackCacheInterval) clearInterval(slackCacheInterval);

        // === 1. 포커스 팝업 전용: 1초 Delta 폴링 (초고속!) ===
        slackDeltaInterval = setInterval(function() {
            if (!slackRealMode || !focusedPopupId) return;
            var fp = findPopup(focusedPopupId);
            if (!fp || fp.minimized) return;

            // 마지막 메시지 timestamp 구하기
            var msgs = dummyMessagesMap[focusedPopupId] || [];
            var lastTs = msgs.length > 0 ? msgs[msgs.length - 1].ts : '0';

            google.script.run
                .withSuccessHandler(function(res) {
                    if (!res || !res.success) return;
                    var newMsgs = res.newMessages || [];
                    if (newMsgs.length === 0) return;

                    // 새 메시지 추가 (중복 방지)
                    var existing = dummyMessagesMap[focusedPopupId] || [];
                    var existingTs = {};
                    existing.forEach(function(m) { existingTs[m.ts] = true; });

                    var added = false;
                    newMsgs.forEach(function(m) {
                        if (!existingTs[m.ts]) {
                            existing.push(m);
                            added = true;
                            // 상대방 메시지면 알림
                            if (!m.mine) {
                                startTabFlash(m.from, m.text);
                                try { playSlackDing(); } catch(e) {}
                            }
                        }
                    });

                    if (added) {
                        dummyMessagesMap[focusedPopupId] = existing;
                        renderPopupMessages(fp.el, focusedPopupId);
                    }
                })
                .getSlackNewMessages(focusedPopupId, lastTs);
        }, 1000);

        // === 2. 비포커스 팝업: 3초마다 Events API 캐시 확인 ===
        slackCacheInterval = setInterval(function() {
            if (!slackRealMode) return;
            var otherPopups = openSlackPopups.filter(function(p) {
                return !p.minimized && p.id !== focusedPopupId;
            });
            if (otherPopups.length > 0) {
                var popupIds = otherPopups.map(function(p) { return p.id; });
                google.script.run
                    .withSuccessHandler(function(res) {
                        if (!res || !res.success) return;
                        var channelsWithNew = res.channels || [];
                        if (channelsWithNew.length > 0) {
                            otherPopups.forEach(function(p) {
                                if (channelsWithNew.indexOf(p.id) !== -1) {
                                    loadRealMessages(p.id, p.el);
                                }
                            });
                        }
                    })
                    .checkSlackEventCache(JSON.stringify(popupIds));
            }

            // 목록 미리보기 갱신 (30초마다)
            if (!window._lastListRefresh || Date.now() - window._lastListRefresh > 30000) {
                window._lastListRefresh = Date.now();
                refreshUnreadCounts();
            }
        }, 3000);
    }

    // [v2.9] 팝업 포커스 추적 — 클릭/입력 시 해당 팝업을 "대화 중"으로
    function setFocusedPopup(popupId) {
        focusedPopupId = popupId;
    }

    // [v3.0] 스레드 답글 로드 — 클릭 시 펼침
    function loadThreadReplies(channelId, threadTs, barEl) {
        var replyContainer = document.getElementById('thread-' + threadTs.replace('.', '-'));
        if (!replyContainer) return;
        // 토글: 이미 열려있으면 닫기
        if (replyContainer.style.display !== 'none') {
            replyContainer.style.display = 'none';
            return;
        }
        replyContainer.style.display = 'block';
        replyContainer.innerHTML = '<div style="padding:8px;color:#64748b;font-size:11px;">답글 불러오는 중...</div>';
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success || !res.replies || res.replies.length === 0) {
                    replyContainer.innerHTML = '<div style="padding:8px;color:#94a3b8;font-size:11px;">답글이 없습니다</div>';
                    return;
                }
                var html = '';
                res.replies.forEach(function(r) {
                    var avatarStyle = 'background:' + avatarColorFromName(r.from) + ';';
                    html +=
                        '<div class="msg-thread-reply">' +
                            '<div class="msg-thread-reply-avatar" style="' + avatarStyle + '">' + firstCharOf(r.from) + '</div>' +
                            '<div class="msg-thread-reply-content">' +
                                '<span class="msg-thread-reply-name">' + escapeHtml(r.from) + '</span>' +
                                '<span class="msg-thread-reply-time">' + escapeHtml(r.time) + '</span>' +
                                '<div class="msg-thread-reply-text">' + escapeHtml(r.text) + '</div>' +
                            '</div>' +
                        '</div>';
                });
                replyContainer.innerHTML = html;
            })
            .withFailureHandler(function() {
                replyContainer.innerHTML = '<div style="padding:8px;color:#ef4444;font-size:11px;">답글 로딩 실패</div>';
            })
            .getSlackThreadReplies(channelId, threadTs);
    }

    // [v3.0] 첫 번째 구독 스레드로 스크롤
    function scrollToFirstThread(channelId) {
        var p = findPopup(channelId);
        if (!p) return;
        var body = p.el.querySelector('.slack-popup-body');
        if (!body) return;
        var firstThread = body.querySelector('.msg-thread-bar.subscribed');
        if (firstThread) {
            firstThread.scrollIntoView({ behavior: 'smooth', block: 'center' });
            firstThread.style.animation = 'none';
            setTimeout(function() { firstThread.style.animation = 'threadPulse 1s ease 3'; }, 10);
        }
    }

    // [v3.0] Slack 앱에서 열기 (팝아웃 대화창)
    // Ctrl+클릭하면 Slack 앱에서 대화창만 단독으로 열 수 있어요!
    function openInSlackApp(channelId) {
        var slackUrl = 'slack://channel?team=T1RV5MJFK&id=' + channelId;
        window.open(slackUrl);
        showToast('Slack 앱에서 열었어요! (Ctrl+클릭 → 단독 창)');
    }

    // [v2.9] 즉시 Delta 폴링 (전송 직후 빠른 응답 확인용)
    function quickDeltaPoll(channelId, afterTs) {
        var fp = findPopup(channelId);
        if (!fp) return;
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success) return;
                var newMsgs = res.newMessages || [];
                if (newMsgs.length === 0) return;
                var existing = dummyMessagesMap[channelId] || [];
                var existingTs = {};
                existing.forEach(function(m) { existingTs[m.ts] = true; });
                var added = false;
                newMsgs.forEach(function(m) {
                    if (!existingTs[m.ts]) {
                        existing.push(m);
                        added = true;
                        if (!m.mine) {
                            startTabFlash(m.from, m.text);
                            try { playSlackDing(); } catch(e) {}
                        }
                    }
                });
                if (added) {
                    dummyMessagesMap[channelId] = existing;
                    renderPopupMessages(fp.el, channelId);
                }
            })
            .getSlackNewMessages(channelId, afterTs);
    }

    function refreshUnreadCounts() {
        // 목록 미리보기 + 정렬도 백그라운드에서 다시 로드
        var allIds = [];
        dummyDMs.forEach(function(d) { allIds.push(d.id); });
        dummyChannels.forEach(function(c) { allIds.push(c.id); });
        if (allIds.length === 0) return;
        var batch = allIds.slice(0, 20);
        google.script.run
            .withSuccessHandler(function(res) {
                if (!res || !res.success || !res.results) return;
                var changed = false;
                dummyDMs.forEach(function(d) {
                    if (res.results[d.id]) {
                        var r = res.results[d.id];
                        if (r.timeRaw > (d.timeRaw || 0)) {
                            d.preview = r.preview || d.preview;
                            d.time = r.time || d.time;
                            d.timeRaw = r.timeRaw || d.timeRaw;
                            changed = true;
                        }
                    }
                });
                dummyChannels.forEach(function(c) {
                    if (res.results[c.id]) {
                        var r = res.results[c.id];
                        if (r.timeRaw > (c.timeRaw || 0)) {
                            c.preview = r.preview || c.preview;
                            c.time = r.time || c.time;
                            c.timeRaw = r.timeRaw || c.timeRaw;
                            changed = true;
                        }
                    }
                });
                if (changed) {
                    renderSlackChatList();
                    updateBrowserTitle();
                }
            })
            .getLastMessagesBatch(JSON.stringify(batch));
    }

    // [v1.0] 알림 소리
    function playSlackDing() {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        var ctx = new AC();
        var now = ctx.currentTime;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.2, now + 0.02);
        gain.gain.linearRampToValueAtTime(0, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.35);
        // 두 번째 톤
        var osc2 = ctx.createOscillator();
        var gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.frequency.value = 1108;
        osc2.type = 'sine';
        gain2.gain.setValueAtTime(0, now + 0.35);
        gain2.gain.linearRampToValueAtTime(0.2, now + 0.37);
        gain2.gain.linearRampToValueAtTime(0, now + 0.7);
        osc2.start(now + 0.35);
        osc2.stop(now + 0.75);
    }

    // [v1.7] 수동 새로고침 — 캐시 강제 삭제 + 재로드
    function manualRefresh() {
        if (!slackRealMode) {
            showToast('Slack 연동 후 사용 가능');
            return;
        }
        showToast('캐시 초기화 + 새로고침...');
        google.script.run
            .withSuccessHandler(function() {
                loadRealSlackData();
            })
            .clearSlackCache();
    }

    // [v0.5] 테스트용 새 메시지 시뮬레이션
    function simulateNewMessage() {
        var targets = ['dm1', 'dm_group1', 'ch1', 'ch3'];
        var targetId = targets[Math.floor(Math.random() * targets.length)];
        var senders = ['박승호', '김성환', '홍완식', '배현희'];
        var sender = senders[Math.floor(Math.random() * senders.length)];
        var texts = [
            '회의 시간 변경 가능할까요?',
            '자료 확인 부탁드립니다',
            '확인했습니다 👍',
            '내일 뵙겠습니다',
            '방금 보낸 파일 봐주세요',
            '@나 체크 부탁해요'
        ];
        var text = texts[Math.floor(Math.random() * texts.length)];
        var now = new Date();
        var hh = String(now.getHours()); if (hh.length < 2) hh = '0' + hh;
        var mm = String(now.getMinutes()); if (mm.length < 2) mm = '0' + mm;
        var newMsg = {
            id: 'm_sim_' + Date.now(),
            from: sender,
            text: text,
            time: hh + ':' + mm,
            mine: false,
            ts: String(now.getTime() / 1000)
        };
        addMessageToChat(targetId, newMsg, { notify: true });
        showToast('시뮬: ' + sender + '님 → ' + targetId);
    }
</script>
