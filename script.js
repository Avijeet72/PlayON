
"use strict";

/* ==========================================
   PLAYON IPTV PLAYER
   SMART AUTO FALLBACK EDITION
========================================== */


/* ==========================================
   DEFAULT SERVER SETTINGS
========================================== */

const DEFAULT_SERVERS = [
    {
        name: "Server 1 - AynaOTT",
        url: "https://raw.githubusercontent.com/Avijeet72/my-playlist/refs/heads/main/20-11-26.m3u"
    },
    {
        name: "Server 2 - BDIX IPTV",
        url: "https://raw.githubusercontent.com/saeidrahmanbd/BDIX-IPTV/main/IPTV-Playlist.m3u"
    },
    {
        name: "Server 3 - BD IPTV",
        url: "https://raw.githubusercontent.com/abusaeeidx/Mrgify-BDIX-IPTV/main/playlist.m3u"
    },
    {
        name: "Server 4 - FreeHunter",
        url: "https://raw.githubusercontent.com/ahan443/FreeHunter/6818129ff8cae015282f65acbf25dce1b927d673/uyycbr.m3u"
    },
    {
        name: "Server 5 - SHIPTV",
        url: "https://raw.githubusercontent.com/shiptv75/SHIPTV/c7d7b3488ce6dc137d5a4d5f246fd4562cd4af2a/playlist.m3u"
    }
];

const PROXY_URL =
    "https://gentle-dawn-5afd.avijeetroy072.workers.dev/";

const STORAGE_KEY = "playon_servers_v1";
const FILE_DB_NAME = "playon_local_playlists";
const FILE_DB_VERSION = 1;
const FILE_STORE_NAME = "playlists";

const OLD_IPTV_ORG_URL =
    "https://iptv-org.github.io/iptv/index.m3u";

const NAVIGATION_HIDE_DELAY = 3000;

const STREAM_START_TIMEOUT = 12000;
const NETWORK_RETRY_DELAY = 1500;
const MAX_NETWORK_RETRIES = 1;

const $ = id => document.getElementById(id);

const video = $("video");
const videoContainer = $("video-container");
const playerShell = $("player-shell");
const channelsBox = $("channels");
const searchInput = $("channel-search");
const channelName = $("channel-name");
const channelCount = $("channel-count");
const searchStatus = $("search-status");
const clearSearchButton = $("clear-search");

let hls = null;
let servers = [];
let channelList = [];
let activeServerId = null;
let currentChannelIndex = -1;
let currentVideoMode = "fit";
let navigationTimer = null;

let playbackSession = 0;
let fallbackQueue = [];
let startupTimer = null;
let networkRetryCount = 0;
let mediaRecoveryUsed = false;
let currentAttemptIndex = -1;

const makeId = () =>
    window.crypto?.randomUUID?.() ||
    "server-" + Date.now() + "-" +
    Math.random().toString(36).slice(2);


/* ==========================================
   INDEXED DB
========================================== */

function openPlaylistDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(
            FILE_DB_NAME,
            FILE_DB_VERSION
        );

        request.onupgradeneeded = () => {
            const db = request.result;

            if (!db.objectStoreNames.contains(FILE_STORE_NAME)) {
                db.createObjectStore(FILE_STORE_NAME, {
                    keyPath: "id"
                });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveLocalPlaylist(id, name, content) {
    const db = await openPlaylistDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(FILE_STORE_NAME, "readwrite");

        tx.objectStore(FILE_STORE_NAME).put({
            id,
            name,
            content
        });

        tx.oncomplete = () => {
            db.close();
            resolve();
        };

        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
}

async function getLocalPlaylist(id) {
    const db = await openPlaylistDB();

    return new Promise((resolve, reject) => {
        const request = db
            .transaction(FILE_STORE_NAME, "readonly")
            .objectStore(FILE_STORE_NAME)
            .get(id);

        request.onsuccess = () => {
            db.close();
            resolve(request.result || null);
        };

        request.onerror = () => {
            db.close();
            reject(request.error);
        };
    });
}

async function deleteLocalPlaylist(id) {
    const db = await openPlaylistDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(FILE_STORE_NAME, "readwrite");

        tx.objectStore(FILE_STORE_NAME).delete(id);

        tx.oncomplete = () => {
            db.close();
            resolve();
        };

        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
}


/* ==========================================
   SERVER STORAGE
========================================== */

function ensureDefaultServers(saved) {
    const result = Array.isArray(saved) ? saved : [];

    const customServers = result.filter(s =>
        s &&
        typeof s.url === "string" &&
        s.url !== OLD_IPTV_ORG_URL &&
        !DEFAULT_SERVERS.some(item =>
            item.name === s.name
        )
    ).map(s => ({
        id: s.id || makeId(),
        name: s.name || "My Server",
        url: s.url,
        type: s.type === "file" ? "file" : "url"
    }));

    const defaults = DEFAULT_SERVERS.map((item, index) => {
        const existing = result.find(s =>
            s &&
            (
                s.name === item.name ||
                s.id === "playon-default-" + (index + 1)
            )
        );

        return {
            id: existing?.id || "playon-default-" + (index + 1),
            name: item.name,
            url: item.url,
            type: "url"
        };
    });

    return [...defaults, ...customServers];
}

function saveServers() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
}

function loadSavedServers() {
    try {
        servers = ensureDefaultServers(
            JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]")
        );
    } catch {
        servers = ensureDefaultServers([]);
    }

    saveServers();
    activeServerId = servers[0]?.id || null;
}

function isDefaultServer(server) {
    return DEFAULT_SERVERS.some(s =>
        s.name === server.name
    );
}

function getActiveServer() {
    return servers.find(s => s.id === activeServerId) || null;
}

function getActiveChannels() {
    return channelList
        .map((channel, index) => ({ ...channel, index }))
        .filter(channel => channel.serverId === activeServerId);
}

function getPlayingChannel() {
    return currentChannelIndex >= 0
        ? channelList[currentChannelIndex]
        : null;
}


/* ==========================================
   SERVER MANAGER
========================================== */

function createServerManager() {
    const panel = $("playlist-panel");
    if (!panel) return;

    const manager = document.createElement("div");
    manager.id = "playon-server-manager";

    manager.innerHTML = `
        <h3 class="server-heading">Playlist Servers</h3>

        <form id="server-add-form">
            <input id="server-name-input"
                type="text" placeholder="Server name" required>

            <input id="server-url-input"
                type="url" placeholder="Paste M3U playlist URL" required>

            <button type="submit" class="load-btn">+ Add Server</button>
        </form>

        <div class="local-playlist-box">
            <h4>Upload Local Playlist</h4>

            <input id="local-playlist-name"
                type="text" placeholder="Playlist name (optional)">

            <label for="local-playlist-input" class="local-upload-label">
                ＋ Choose M3U / M3U8 File
            </label>

            <input id="local-playlist-input" type="file"
                accept=".m3u,.m3u8" hidden>

            <p id="local-upload-status">
                Select a playlist file from your computer.
            </p>
        </div>

        <button type="button" id="load-all-servers">
            Load All Servers
        </button>

        <div id="server-list"></div>

        <p class="server-hint">
            Five default servers included. Add unlimited playlists.
        </p>
    `;

    panel.appendChild(manager);

    $("server-add-form").addEventListener("submit", event => {
        event.preventDefault();

        const name = $("server-name-input").value.trim();
        const url = $("server-url-input").value.trim();

        try {
            const parsed = new URL(url);

            if (!["http:", "https:"].includes(parsed.protocol)) {
                throw new Error();
            }

            if (servers.some(s => s.url === parsed.href)) {
                alert("This playlist is already added.");
                return;
            }

            const server = {
                id: makeId(),
                name,
                url: parsed.href,
                type: "url"
            };

            servers.push(server);
            saveServers();

            $("server-name-input").value = "";
            $("server-url-input").value = "";

            renderServerList();
            renderServerTabs();
            loadOneServer(server, true);

        } catch {
            alert("Enter a valid HTTP/HTTPS playlist URL.");
        }
    });

    $("local-playlist-input").addEventListener(
        "change",
        handleLocalPlaylistUpload
    );

    $("load-all-servers").addEventListener("click", loadAllServers);

    renderServerList();
}


/* ==========================================
   LOCAL PLAYLIST UPLOAD
========================================== */

async function handleLocalPlaylistUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const status = $("local-upload-status");

    try {
        if (!/\.(m3u|m3u8)$/i.test(file.name)) {
            throw new Error("Select an M3U or M3U8 file.");
        }

        status.textContent = "Reading playlist...";

        const content = await file.text();

        if (!content.includes("#EXTM3U")) {
            throw new Error("Invalid M3U playlist.");
        }

        const name = $("local-playlist-name").value.trim() ||
            file.name.replace(/\.(m3u|m3u8)$/i, "");

        const server = {
            id: makeId(),
            name,
            url: "local-file://" + makeId(),
            type: "file"
        };

        await saveLocalPlaylist(server.id, file.name, content);

        servers.push(server);
        saveServers();

        $("local-playlist-name").value = "";

        renderServerList();
        renderServerTabs();

        await loadOneServer(server, true);

        status.textContent = "Playlist uploaded successfully.";

    } catch (error) {
        status.textContent = error.message;
        alert("Upload failed: " + error.message);

    } finally {
        event.target.value = "";
    }
}


/* ==========================================
   SERVER LIST
========================================== */

function renderServerList() {
    const list = $("server-list");
    if (!list) return;

    list.innerHTML = "";

    servers.forEach((server, index) => {
        const item = document.createElement("div");
        item.className = "server-item";
        item.dataset.serverId = server.id;

        const info = document.createElement("div");
        info.className = "server-info";

        const name = document.createElement("strong");
        name.textContent = server.name;

        const type = document.createElement("small");
        type.textContent = server.type === "file"
            ? "Local Playlist"
            : `Server ${index + 1}`;

        info.append(name, type);

        const actions = document.createElement("div");
        actions.className = "server-buttons";

        const load = document.createElement("button");
        load.textContent = "Load";
        load.type = "button";
        load.addEventListener("click", () => loadOneServer(server, true));

        actions.appendChild(load);

        if (!isDefaultServer(server)) {
            const remove = document.createElement("button");
            remove.textContent = "×";
            remove.type = "button";
            remove.className = "server-remove";
            remove.addEventListener("click", () => removeServer(server));
            actions.appendChild(remove);
        }

        item.append(info, actions);
        list.appendChild(item);
    });
}

async function removeServer(server) {
    if (isDefaultServer(server)) {
        alert("Default servers cannot be removed.");
        return;
    }

    if (!confirm(`Remove ${server.name}?`)) return;

    const playing = getPlayingChannel();

    if (playing?.serverId === server.id) {
        stopPlayer();
        currentChannelIndex = -1;
    }

    servers = servers.filter(s => s.id !== server.id);
    channelList = channelList.filter(c => c.serverId !== server.id);

    if (server.type === "file") {
        try {
            await deleteLocalPlaylist(server.id);
        } catch (error) {
            console.error(error);
        }
    }

    if (playing && playing.serverId !== server.id) {
        currentChannelIndex = channelList.findIndex(
            c => c.serverId === playing.serverId && c.url === playing.url
        );
    }

    if (activeServerId === server.id) {
        activeServerId = servers[0]?.id || null;
    }

    saveServers();
    renderServerList();
    renderServerTabs();
    renderChannels();
    updateChannelCount();
}


/* ==========================================
   SERVER TABS
========================================== */

function createServerTabs() {
    const tabs = document.createElement("div");
    tabs.id = "playon-server-tabs";
    tabs.className = "playon-server-tabs";

    channelsBox.parentNode.insertBefore(tabs, channelsBox);
}

function renderServerTabs() {
    const tabs = $("playon-server-tabs");
    if (!tabs) return;

    tabs.innerHTML = "";

    servers.forEach(server => {
        const count = channelList.filter(
            c => c.serverId === server.id
        ).length;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "playon-server-tab";

        if (server.id === activeServerId) {
            button.classList.add("active");
        }

        button.textContent = server.name;

        const badge = document.createElement("small");
        badge.textContent = count;
        button.appendChild(badge);

        button.addEventListener("click", () => {
            const playing = getPlayingChannel();

            cancelFallback();

            if (playing && playing.serverId !== server.id) {
                stopPlayer();
                currentChannelIndex = -1;
            }

            activeServerId = server.id;

            searchInput.value = "";
            updateClearButton();

            renderServerTabs();
            renderChannels();
            updateChannelCount();
        });

        tabs.appendChild(button);
    });
}


/* ==========================================
   M3U PARSER
========================================== */

function parseM3U(data, playlistUrl, server) {
    const parsed = [];
    const lines = data.split(/\r?\n/);

    let name = "Unknown Channel";
    let logo = "";

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (line.startsWith("#EXTINF:")) {
            const comma = line.lastIndexOf(",");

            name = comma >= 0
                ? line.slice(comma + 1).trim()
                : "Unknown Channel";

            const match = line.match(/tvg-logo="([^"]*)"/i);
            logo = match ? match[1] : "";
            continue;
        }

        if (line.startsWith("#")) continue;

        try {
            if (server.type === "file" && !/^https?:\/\//i.test(line)) {
                console.warn("Skipping relative stream:", line);
                name = "Unknown Channel";
                logo = "";
                continue;
            }

            const url = new URL(line, playlistUrl);

            if (!["http:", "https:"].includes(url.protocol)) continue;

            parsed.push({
                id: makeId(),
                name,
                url: url.href,
                logo,
                server: server.name,
                serverId: server.id
            });

        } catch (error) {
            console.warn("Invalid stream:", line);
        }

        name = "Unknown Channel";
        logo = "";
    }

    return parsed;
}


/* ==========================================
   LOAD SERVER
========================================== */

function isSkyM3U(server) {
    return server.type !== "file" &&
        server.url.includes("go.skym3u.dev");
}

function getProxyURL(url) {
    return PROXY_URL + "?url=" + encodeURIComponent(url);
}

async function loadOneServer(server, activate = false) {
    const row = [...document.querySelectorAll(".server-item")]
        .find(item => item.dataset.serverId === server.id);

    const playing = getPlayingChannel();

    try {
        row?.classList.add("server-loading");

        let data;
        let playlistURL = server.url;

        if (server.type === "file") {
            const saved = await getLocalPlaylist(server.id);

            if (!saved) {
                throw new Error("Local playlist not found. Upload again.");
            }

            data = saved.content;
            playlistURL = "https://playon.invalid/";

        } else {
            playlistURL = isSkyM3U(server)
                ? getProxyURL(server.url)
                : server.url;

            const response = await fetch(playlistURL, {
                cache: "no-store"
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            data = await response.text();
        }

        if (!data.includes("#EXTM3U")) {
            throw new Error("Invalid M3U playlist.");
        }

        const parsed = parseM3U(data, playlistURL, server);

        channelList = channelList.filter(c => c.serverId !== server.id);
        channelList.push(...parsed);

        if (playing) {
            currentChannelIndex = channelList.findIndex(
                c => c.serverId === playing.serverId && c.url === playing.url
            );

            if (currentChannelIndex === -1) stopPlayer();
        }

        if (activate) {
            if (playing && playing.serverId !== server.id) {
                stopPlayer();
                currentChannelIndex = -1;
            }

            activeServerId = server.id;
            searchInput.value = "";
            updateClearButton();
        }

        renderServerTabs();
        renderChannels();
        updateChannelCount();

        console.info(`${server.name}: ${parsed.length} channels loaded`);

        if (!parsed.length) {
            alert(`${server.name}: No playable stream URLs found.`);
        }

    } catch (error) {
        console.error(error);
        alert(`Unable to load ${server.name}:\n${error.message}`);

    } finally {
        row?.classList.remove("server-loading");
    }
}

async function loadAllServers() {
    const button = $("load-all-servers");

    if (button) {
        button.disabled = true;
        button.textContent = "Loading...";
    }

    const selected = activeServerId;

    try {
        await Promise.allSettled(
            servers.map(server => loadOneServer(server, false))
        );

        activeServerId = servers.some(s => s.id === selected)
            ? selected
            : servers[0]?.id || null;

    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = "Load All Servers";
        }

        renderServerList();
        renderServerTabs();
        renderChannels();
        updateChannelCount();
    }
}


/* ==========================================
   CHANNEL DISPLAY
========================================== */

function updateChannelCount() {
    if (!channelCount) return;

    const count = getActiveChannels().length;
    channelCount.textContent = `${count.toLocaleString()} CHANNELS`;
}

function renderChannels() {
    if (!channelsBox) return;

    const query = (searchInput?.value || "").trim().toLowerCase();

    channelsBox.innerHTML = "";

    const filtered = getActiveChannels().filter(channel =>
        channel.name.toLowerCase().includes(query)
    );

    filtered.forEach(channel => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "channel";

        if (channel.index === currentChannelIndex) {
            item.classList.add("selected");
        }

        const title = document.createElement("span");
        title.className = "channel-title";
        title.textContent = channel.name;

        const server = document.createElement("small");
        server.className = "channel-server";
        server.textContent = channel.server;

        item.append(title, server);

        item.addEventListener("click", () => playChannel(channel.index));

        channelsBox.appendChild(item);
    });

    if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";

        const heading = document.createElement("h3");
        heading.textContent = query
            ? "No matching channels"
            : "No channels loaded";

        const message = document.createElement("p");
        message.textContent = query
            ? "Try another channel."
            : "Load a playlist to see channels.";

        empty.append(heading, message);
        channelsBox.appendChild(empty);
    }

    if (searchStatus) {
        searchStatus.textContent = query
            ? `${filtered.length} matching channels`
            : `${getActiveChannels().length} channels available`;
    }
}


/* ==========================================
   SEARCH
========================================== */

function updateClearButton() {
    clearSearchButton?.classList.toggle(
        "visible",
        !!searchInput?.value
    );
}

searchInput?.addEventListener("input", () => {
    updateClearButton();
    renderChannels();
});

clearSearchButton?.addEventListener("click", () => {
    searchInput.value = "";
    updateClearButton();
    renderChannels();
    searchInput.focus();
});

function focusChannelSearch() {
    $("channel-guide")?.scrollIntoView({ behavior: "smooth" });
    setTimeout(() => searchInput?.focus(), 350);
}

$("header-search-btn")?.addEventListener("click", focusChannelSearch);
$("mobile-search-btn")?.addEventListener("click", focusChannelSearch);


/* ==========================================
   SMART AUTO FALLBACK
========================================== */

function normalizeChannelName(name) {
    return String(name || "")
        .toLowerCase()
        .replace(/\b(hd|fhd|uhd|4k|sd|live)\b/g, "")
        .replace(/[^a-z0-9]/g, "")
        .trim();
}

function clearStartupTimer() {
    if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
    }
}

function cancelFallback() {
    playbackSession++;
    clearStartupTimer();
    fallbackQueue = [];
    networkRetryCount = 0;
    mediaRecoveryUsed = false;
    currentAttemptIndex = -1;
}

function buildFallbackQueue(originalIndex) {
    const original = channelList[originalIndex];

    if (!original) return [];

    const queue = [];

    const targetName = normalizeChannelName(original.name);

    const sameChannelMatches = channelList
        .map((channel, index) => ({
            ...channel,
            index
        }))
        .filter(channel =>
            channel.serverId !== original.serverId &&
            normalizeChannelName(channel.name) === targetName
        );

    const usedURLs = new Set([original.url]);

    sameChannelMatches.forEach(channel => {
        if (!usedURLs.has(channel.url)) {
            usedURLs.add(channel.url);
            queue.push(channel.index);
        }
    });

    const originalServerChannels = channelList
        .map((channel, index) => ({
            ...channel,
            index
        }))
        .filter(channel => channel.serverId === original.serverId);

    const currentPosition = originalServerChannels.findIndex(
        channel => channel.index === originalIndex
    );

    const nextChannel = originalServerChannels[currentPosition + 1];

    if (nextChannel && !usedURLs.has(nextChannel.url)) {
        queue.push(nextChannel.index);
    }

    return queue;
}

function startFallbackTimer(session) {
    clearStartupTimer();

    startupTimer = setTimeout(() => {
        if (session !== playbackSession) return;

        console.warn("Stream startup timeout. Trying fallback.");

        tryNextFallback(session);

    }, STREAM_START_TIMEOUT);
}

function onPlaybackStarted(session, player) {
    if (session !== playbackSession) return;
    if (player && hls !== player) return;

    clearStartupTimer();

    fallbackQueue = [];
    networkRetryCount = 0;
    mediaRecoveryUsed = false;

    console.info("PlayON: Playback started successfully.");

    renderServerTabs();
    renderChannels();
}

function tryNextFallback(session) {
    if (session !== playbackSession) return;

    clearStartupTimer();

    if (hls) {
        hls.destroy();
        hls = null;
    }

    video.pause();
    video.removeAttribute("src");
    video.load();

    if (fallbackQueue.length > 0) {
        const nextIndex = fallbackQueue.shift();

        const nextChannel = channelList[nextIndex];

        if (nextChannel) {
            console.info(
                "PlayON: Trying fallback:",
                nextChannel.name,
                nextChannel.server
            );

            startChannelAttempt(nextIndex, session);
            return;
        }
    }

    channelName.textContent = "Stream unavailable";

    console.warn("PlayON: All fallback attempts failed.");

    renderChannels();
    renderServerTabs();
}

function startChannelAttempt(index, session) {
    if (session !== playbackSession) return;

    const channel = channelList[index];

    if (!channel) {
        tryNextFallback(session);
        return;
    }

    currentAttemptIndex = index;
    currentChannelIndex = index;

    activeServerId = channel.serverId;

    networkRetryCount = 0;
    mediaRecoveryUsed = false;

    channelName.textContent = channel.name;

    renderServerTabs();
    renderChannels();
    updateChannelCount();

    if (hls) {
        hls.destroy();
        hls = null;
    }

    video.pause();
    video.removeAttribute("src");
    video.load();

    startFallbackTimer(session);

    if (window.Hls && Hls.isSupported()) {

        const player = new Hls({
            startPosition: -1,

            maxBufferLength: 15,
            maxMaxBufferLength: 30,
            maxBufferSize: 30 * 1000 * 1000,
            backBufferLength: 10,

            lowLatencyMode: false,
            liveSyncDurationCount: 2,
            liveMaxLatencyDurationCount: 6,
            maxLiveSyncPlaybackRate: 1.2,

            manifestLoadingMaxRetry: 4,
            manifestLoadingRetryDelay: 1000,

            levelLoadingMaxRetry: 4,
            levelLoadingRetryDelay: 1000,

            fragLoadingMaxRetry: 4,
            fragLoadingRetryDelay: 1000,

            startFragPrefetch: true,
            enableWorker: true
        });

        hls = player;

        player.on(Hls.Events.MANIFEST_PARSED, () => {
            if (session !== playbackSession || hls !== player) return;

            video.play().catch(error => {
                console.warn("Playback error:", error);
            });
        });

        player.on(Hls.Events.ERROR, (_event, data) => {
            if (session !== playbackSession || hls !== player) return;
            if (!data.fatal) return;

            console.warn(
                "HLS fatal error:",
                data.type,
                data.details
            );

            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {

                if (networkRetryCount < MAX_NETWORK_RETRIES) {
                    networkRetryCount++;

                    console.log("Retrying network connection...");

                    setTimeout(() => {
                        if (session === playbackSession && hls === player) {
                            player.startLoad();
                        }
                    }, NETWORK_RETRY_DELAY);

                } else {
                    tryNextFallback(session);
                }

            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {

                if (!mediaRecoveryUsed) {
                    mediaRecoveryUsed = true;
                    player.recoverMediaError();

                } else {
                    tryNextFallback(session);
                }

            } else {
                tryNextFallback(session);
            }
        });

        player.loadSource(channel.url);
        player.attachMedia(video);

        video.addEventListener("playing", () => {
            onPlaybackStarted(session, player);
        }, { once: true });

    } else {

        video.src = channel.url;

        video.addEventListener("loadedmetadata", () => {
            if (session !== playbackSession) return;
            seekToLiveEdge();
        }, { once: true });

        video.addEventListener("playing", () => {
            onPlaybackStarted(session, null);
        }, { once: true });

        video.addEventListener("error", () => {
            if (session === playbackSession) {
                tryNextFallback(session);
            }
        }, { once: true });

        video.play().catch(error => {
            console.warn("Native playback error:", error);
        });
    }

    showPlayerNavigation();

    if (window.matchMedia("(max-width: 700px)").matches) {
        $("watch").scrollIntoView({ behavior: "smooth" });
    }
}

function playChannel(index) {
    if (index < 0 || index >= channelList.length) return;

    const channel = channelList[index];

    if (!channel) return;

    cancelFallback();

    const session = playbackSession;

    fallbackQueue = buildFallbackQueue(index);

    console.info(
        "PlayON: Fallback candidates:",
        fallbackQueue.length
    );

    startChannelAttempt(index, session);
}


/* ==========================================
   STOP PLAYER
========================================== */

function stopPlayer() {
    cancelFallback();

    if (hls) {
        hls.destroy();
        hls = null;
    }

    video.pause();
    video.removeAttribute("src");
    video.load();

    channelName.textContent = "Select a channel";

    hidePlayerNavigation();
}


/* ==========================================
   SEEK TO LIVE EDGE
========================================== */

function seekToLiveEdge() {
    try {
        if (video.seekable.length) {
            const end = video.seekable.end(video.seekable.length - 1);

            if (end > 0) {
                video.currentTime = Math.max(0, end - 1);
            }
        }
    } catch (error) {
        console.debug(error);
    }
}


/* ==========================================
   PREVIOUS / NEXT
========================================== */

function navigateChannel(direction) {
    const active = getActiveChannels();

    if (!active.length) return;

    const position = active.findIndex(
        c => c.index === currentChannelIndex
    );

    let next = position === -1
        ? (direction > 0 ? 0 : active.length - 1)
        : position + direction;

    if (next < 0 || next >= active.length) return;

    playChannel(active[next].index);
}

function previousChannel() {
    navigateChannel(-1);
}

function nextChannel() {
    navigateChannel(1);
}

window.previousChannel = previousChannel;
window.nextChannel = nextChannel;


/* ==========================================
   VIDEO FIT / STRETCH
========================================== */

function setVideoMode(mode) {
    if (!["fit", "stretch"].includes(mode)) return;

    currentVideoMode = mode;

    const fitValue = mode === "fit" ? "contain" : "fill";

    video.style.setProperty("--playon-video-fit", fitValue);
    video.style.setProperty("object-fit", fitValue, "important");

    $("fit-btn")?.classList.toggle("active", mode === "fit");
    $("stretch-btn")?.classList.toggle("active", mode === "stretch");
}


/* ==========================================
   CUSTOM PLAYER FULLSCREEN
========================================== */

function isPlayerFullscreen() {
    return (
        document.fullscreenElement === playerShell ||
        document.webkitFullscreenElement === playerShell ||
        playerShell.matches(":fullscreen") ||
        playerShell.matches(":-webkit-full-screen")
    );
}

async function enterPlayerFullscreen() {
    try {
        if (isPlayerFullscreen()) {
            if (document.exitFullscreen) {
                await document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
            return;
        }

        if (playerShell.requestFullscreen) {
            await playerShell.requestFullscreen();

        } else if (playerShell.webkitRequestFullscreen) {
            playerShell.webkitRequestFullscreen();

        } else {
            alert("Fullscreen is not supported by this browser.");
            return;
        }

        showPlayerNavigation();

        if (screen.orientation?.lock) {
            try {
                await screen.orientation.lock("landscape");
            } catch (error) {
                console.warn("Landscape lock unavailable:", error);
            }
        }

    } catch (error) {
        console.error("Fullscreen error:", error);
        alert("Unable to enter fullscreen. Try using HTTPS or localhost.");
    }
}

function unlockScreenOrientation() {
    if (screen.orientation?.unlock) {
        try {
            screen.orientation.unlock();
        } catch (error) {
            console.warn(error);
        }
    }
}



/* ==========================================
   PLAYER NAVIGATION AUTO HIDE
========================================== */

function showPlayerNavigation() {
    if (!videoContainer) return;

    clearTimeout(navigationTimer);
    navigationTimer = null;

    videoContainer.classList.add("show-navigation");
    playerShell?.classList.add("show-navigation");

    // Automatically hide after 3 seconds of inactivity
    scheduleNavigationHide();
}

function scheduleNavigationHide() {
    clearTimeout(navigationTimer);

    navigationTimer = setTimeout(() => {
        hidePlayerNavigation();
    }, NAVIGATION_HIDE_DELAY);
}

function hidePlayerNavigation() {
    clearTimeout(navigationTimer);
    navigationTimer = null;

    videoContainer?.classList.remove("show-navigation");
    playerShell?.classList.remove("show-navigation");
}

function handleFullscreenChange() {
    if (isPlayerFullscreen()) {
        showPlayerNavigation();

        if (screen.orientation?.lock) {
            screen.orientation.lock("landscape").catch(() => {});
        }

    } else {
        unlockScreenOrientation();
        hidePlayerNavigation();
    }
}




/* ==========================================
   CENTER PLAY / PAUSE BUTTON
========================================== */

function createCenterPlayButton() {
    const navigation = videoContainer.querySelector(".video-navigation");
    if (!navigation) return;

    let button = $("center-play-btn");

    if (!button) {
        button = document.createElement("button");

        button.type = "button";
        button.id = "center-play-btn";
        button.className = "center-play-btn";

        navigation.insertBefore(
            button,
            $("video-next-btn")
        );
    }

    button.setAttribute("aria-label", "Play");

    button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();

        if (video.paused) {
            video.play().catch(console.warn);
        } else {
            video.pause();
        }

        showPlayerNavigation();
    });

    video.removeAttribute("controls");

    video.addEventListener("play", updateCenterPlayButton);
    video.addEventListener("pause", updateCenterPlayButton);

    updateCenterPlayButton();
}

function updateCenterPlayButton() {
    const button = $("center-play-btn");
    if (!button) return;

    button.textContent = video.paused ? "▶" : "Ⅱ";

    button.setAttribute(
        "aria-label",
        video.paused ? "Play" : "Pause"
    );
}


/* ==========================================
   FIND FULLSCREEN / FIT / STRETCH CONTROLS
========================================== */

function prepareScreenControls() {
    const fitButton = $("fit-btn");
    const stretchButton = $("stretch-btn");
    const fullscreenButton = $("fullscreen-btn");

    if (!fitButton || !stretchButton || !fullscreenButton) {
        console.warn("PlayOn: Player control buttons not found.");
        return;
    }

    const existing = playerShell.querySelector(".screen-controls");

    if (existing &&
        existing.contains(fitButton) &&
        existing.contains(stretchButton) &&
        existing.contains(fullscreenButton)) {
        return;
    }

    let parent = fitButton.parentElement;

    while (parent && parent !== playerShell) {
        if (
            parent.contains(stretchButton) &&
            parent.contains(fullscreenButton)
        ) {
            parent.classList.add("screen-controls");
            return;
        }

        parent = parent.parentElement;
    }

    console.warn(
        "PlayOn: Could not find a common parent for player controls."
    );
}



/* ==========================================
   NAVIGATION CSS
========================================== */

function installNavigationCSS() {
    if ($("playon-navigation-auto-hide-css")) return;

    const style = document.createElement("style");
    style.id = "playon-navigation-auto-hide-css";

    style.textContent = `
        #player-shell:fullscreen,
        #player-shell:-webkit-full-screen {
            width: 100% !important;
            height: 100% !important;
            max-width: none !important;
            max-height: none !important;
            margin: 0 !important;
            padding: 0 !important;
            background: #000 !important;
            overflow: hidden !important;
            display: flex !important;
            flex-direction: column !important;
        }

        #player-shell:fullscreen .player-top,
        #player-shell:-webkit-full-screen .player-top,
        #player-shell:fullscreen .player-details,
        #player-shell:-webkit-full-screen .player-details {
            display: none !important;
        }

        #player-shell:fullscreen .video-container,
        #player-shell:-webkit-full-screen .video-container {
            position: relative !important;
            flex: 1 1 0% !important;
            width: 100% !important;
            height: 100% !important;
            min-width: 0 !important;
            min-height: 0 !important;
            aspect-ratio: auto !important;
            background: #000 !important;
            overflow: hidden !important;
        }

        /* SCREEN CONTROLS */
        #player-shell .screen-controls {
            display: flex !important;
            position: relative !important;
            z-index: 9999 !important;
            flex-shrink: 0 !important;
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
            transition: opacity .25s ease, visibility .25s ease !important;
        }

        #player-shell.show-navigation .screen-controls {
            opacity: 1 !important;
            visibility: visible !important;
            pointer-events: auto !important;
        }

        /* FULLSCREEN CONTROLS */
        #player-shell:fullscreen .screen-controls,
        #player-shell:-webkit-full-screen .screen-controls {
            position: absolute !important;
            bottom: 18px !important;
            right: 20px !important;
            z-index: 99999 !important;
            background: rgba(0,0,0,.65) !important;
            border-radius: 10px !important;
            padding: 8px !important;
        }

        #player-shell:fullscreen.show-navigation .screen-controls,
        #player-shell:-webkit-full-screen.show-navigation .screen-controls {
            opacity: 1 !important;
            visibility: visible !important;
            pointer-events: auto !important;
        }

        /* VIDEO NAVIGATION */
        #video-container {
            position: relative !important;
        }

        #video-container .video-navigation {
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            display: flex !important;
            flex-direction: row !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 24px !important;
            width: auto !important;
            height: auto !important;
            z-index: 100 !important;
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
            transition: opacity .25s ease, visibility .25s ease !important;
        }

        #video-container.show-navigation .video-navigation {
            opacity: 1 !important;
            visibility: visible !important;
        }

        #video-container .video-navigation button {
            pointer-events: auto !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            border-radius: 50% !important;
            cursor: pointer !important;
            flex-shrink: 0 !important;
        }

        #video-container .video-navigation .center-play-btn {
            width: 82px !important;
            height: 82px !important;
            font-size: 34px !important;
            background: #ffb900 !important;
            color: #111 !important;
            border: 3px solid rgba(255,255,255,.7) !important;
            box-shadow: 0 4px 18px rgba(0,0,0,.4) !important;
        }

        #video-container .video-navigation #video-previous-btn,
        #video-container .video-navigation #video-next-btn {
            width: 58px !important;
            height: 58px !important;
            font-size: 30px !important;
            background: rgba(10,20,38,.92) !important;
            color: #20c9e8 !important;
            border: 2px solid #20c9e8 !important;
        }

        @media (max-width: 700px) {
            #player-shell:fullscreen .screen-controls,
            #player-shell:-webkit-full-screen .screen-controls {
                right: 10px !important;
                bottom: 10px !important;
                padding: 6px !important;
            }

            #video-container .video-navigation {
                gap: 15px !important;
            }

            #video-container .video-navigation .center-play-btn {
                width: 68px !important;
                height: 68px !important;
                font-size: 29px !important;
            }

            #video-container .video-navigation #video-previous-btn,
            #video-container .video-navigation #video-next-btn {
                width: 48px !important;
                height: 48px !important;
                font-size: 25px !important;
            }
        }

        @media (max-width: 420px) {
            #video-container .video-navigation {
                gap: 12px !important;
            }

            #video-container .video-navigation .center-play-btn {
                width: 60px !important;
                height: 60px !important;
            }

            #video-container .video-navigation #video-previous-btn,
            #video-container .video-navigation #video-next-btn {
                width: 44px !important;
                height: 44px !important;
            }
        }
    `;

    document.head.appendChild(style);
}



/* ==========================================
   BUTTON EVENTS
========================================== */

$("fit-btn").addEventListener("click", () => {
    setVideoMode("fit");
    showPlayerNavigation();
});

$("stretch-btn").addEventListener("click", () => {
    setVideoMode("stretch");
    showPlayerNavigation();
});

$("fullscreen-btn").addEventListener("click", () => {
    enterPlayerFullscreen();
    showPlayerNavigation();
});

$("video-previous-btn").addEventListener("click", event => {
    event.stopPropagation();
    previousChannel();
    showPlayerNavigation();
});

$("video-next-btn").addEventListener("click", event => {
    event.stopPropagation();
    nextChannel();
    showPlayerNavigation();
});

$("details-previous-btn").addEventListener("click", previousChannel);
$("details-next-btn").addEventListener("click", nextChannel);


/* ==========================================
   PLAYER INTERACTION
========================================== */

// Desktop mouse and pen interaction.
playerShell.addEventListener("pointerenter", event => {
    if (event.pointerType !== "touch") {
        showPlayerNavigation();
    }
});

playerShell.addEventListener("pointermove", event => {
    if (event.pointerType !== "touch") {
        showPlayerNavigation();
    }
}, { passive: true });

// Hide only after leaving the complete player area.
playerShell.addEventListener("pointerleave", event => {
    if (event.pointerType !== "touch") {
        scheduleNavigationHide();
    }
});

// Mobile touch interaction.
playerShell.addEventListener("touchstart", () => {
    showPlayerNavigation();
}, { passive: true });

playerShell.addEventListener("touchend", () => {
    scheduleNavigationHide();
}, { passive: true });

playerShell.addEventListener("touchcancel", () => {
    scheduleNavigationHide();
}, { passive: true });

// Keyboard accessibility.
playerShell.addEventListener("focusin", () => {
    showPlayerNavigation();
});

playerShell.addEventListener("focusout", event => {
    if (!playerShell.contains(event.relatedTarget)) {
        scheduleNavigationHide();
    }
});

// Clicking the video also reveals the controls.
videoContainer.addEventListener("click", event => {
    if (!event.target.closest(".video-navigation button")) {
        showPlayerNavigation();
    }
});


/* ==========================================
   FULLSCREEN EVENTS
========================================== */

document.addEventListener("fullscreenchange", handleFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleFullscreenChange);


/* ==========================================
   INITIALIZATION
========================================== */

function initializePlayOn() {
    prepareScreenControls();

    installNavigationCSS();

    video.removeAttribute("controls");

    createCenterPlayButton();

    loadSavedServers();

    createServerManager();
    createServerTabs();

    renderServerList();
    renderServerTabs();

    setVideoMode(currentVideoMode);
    updateClearButton();

    hidePlayerNavigation();

    loadAllServers();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializePlayOn);
} else {
    initializePlayOn();
}
