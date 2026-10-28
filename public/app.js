// osu-render web UI. Plain ES module, no build step: every dynamic text goes through textContent or DOM APIs.
const $ = (selector) => document.querySelector(selector);

const ROUTES = ['render', 'history', 'skins', 'diagnostics'];
const DEFAULT_ROUTE = 'render';
const FALLBACK_LANGUAGE = 'en';
const LANGUAGE_STORAGE_KEY = 'language';
const TOKEN_STORAGE_KEY = 'serviceToken';
const ACTIVE_JOB_STORAGE_KEY = 'activeJob';
const PRESETS_STORAGE_KEY = 'renderPresets';
const LAST_OPTIONS_STORAGE_KEY = 'lastRenderOptions';
const UPDATE_STORAGE_KEY = 'updateTarget';
const HEALTH_REFRESH_MS = 30_000;
const JOB_POLL_MS = 1500;
const HISTORY_POLL_MS = 4000;
const HISTORY_LIMIT = 20;
const UPDATE_POLL_MS = 2000;
const UPDATE_RESTART_TIMEOUT_MS = 10 * 60_000;
const ISSUE_URL_PREFIX = 'https://github.com/';
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
const STEPS = ['uploaded', 'resolving', 'downloading', 'queued', 'rendering', 'completed'];
const STEP_OF_STATUS = { uploaded: 0, resolving: 1, downloading: 2, queued: 3, rendering: 4, finalizing: 4, completed: 5 };
// Problems with the file itself: uploading the same file again can't help.
const FILE_ERRORS = ['INVALID_REPLAY', 'UNSUPPORTED_MODE', 'REPLAY_TOO_LARGE', 'BEATMAP_NOT_FOUND', 'BEATMAP_CHECKSUM_MISMATCH', 'INVALID_OPTIONS'];
const ENCODER_FAMILIES = [[/_nvenc$/, 'nvenc'], [/_amf$/, 'amf'], [/_qsv$/, 'qsv'], [/^libx264$/, 'x264']];
const I18N_ATTRIBUTES = ['placeholder', 'aria-label'];
const PERCENT_RANGES = ['masterVolume', 'musicVolume', 'sampleVolume', 'backgroundDim', 'backgroundBlur', 'playfieldScale'];

const languageSelect = $('#language');
const LANGUAGES = [...languageSelect.options].map((option) => option.value);
const tabs = [...document.querySelectorAll('#tabs [data-route]')];
const views = Object.fromEntries(ROUTES.map((route) => [route, $(`#view-${route}`)]));
const rendererStatus = $('#rendererStatus');
const rendererLabel = $('#rendererLabel');
const rendererReason = $('#rendererReason');
const updateBanner = $('#updateBanner');
const updateTitle = $('#updateTitle');
const updateDetail = $('#updateDetail');
const updateApply = $('#updateApply');
const updateNotes = $('#updateNotes');
const drop = $('#drop');
const fileInput = $('#file');
const tokenField = $('#tokenField');
const token = $('#token');
const jobCard = $('#job');
const jobTitle = $('#jobTitle');
const jobSub = $('#jobSub');
const steps = [...document.querySelectorAll('#steps [data-step]')];
const jobStatus = $('#jobStatus');
const progressBox = $('#progressBox');
const progressBar = $('#progress');
const progressFill = $('#progressFill');
const progressPercent = $('#progressPercent');
const progressSpeed = $('#progressSpeed');
const progressEta = $('#progressEta');
const jobError = $('#jobError');
const jobErrorText = $('#jobErrorText');
const jobResult = $('#jobResult');
const jobVideo = $('#jobVideo');
const downloadButton = $('#download');
const retryButton = $('#retry');
const cancelButton = $('#cancel');
const anotherButton = $('#another');
const skinSelect = $('#skin');
const moreSettings = $('#moreSettings');
const drawer = $('#settingsDrawer');
const drawerClose = $('#drawerClose');
const settingsSearch = $('#settingsSearch');
const settingsNoMatch = $('#settingsNoMatch');
const presetSelect = $('#presetSelect');
const presetSave = $('#presetSave');
const presetDelete = $('#presetDelete');
const presetReset = $('#presetReset');
const presetStatus = $('#presetStatus');
const historyList = $('#historyList');
const historyEmpty = $('#historyEmpty');
const historyStatus = $('#historyStatus');
const historyRefresh = $('#historyRefresh');
const skinDrop = $('#skinDrop');
const skinFile = $('#skinFile');
const skinStatus = $('#skinStatus');
const skinList = $('#skinList');
const rendererFacts = $('#rendererFacts');
const probeList = $('#probeList');
const probesEmpty = $('#probesEmpty');
const diagnosticsCard = $('#diagnostics');
const diagDownload = $('#diagDownload');
const diagCopy = $('#diagCopy');
const diagIssue = $('#diagIssue');
const diagSend = $('#diagSend');
const diagStatus = $('#diagStatus');
const diagSummary = $('#diagSummary');
const diagPrivacy = $('#diagPrivacy');
const diagAutoSend = $('#diagAutoSend');
const previewDialog = $('#previewDialog');
const previewTitle = $('#previewTitle');
const previewVideo = $('#previewVideo');
const previewClose = $('#previewClose');
const optionControls = [...document.querySelectorAll('[data-option]')];
const DEFAULT_OPTIONS = renderOptions();

let messages = null;
let languageRequest = 0;
let route = null;
let health = null;
let jobId = null;
let jobTimer = null;
let currentJob = null;
let jobProblem = null;
let lastFile = null;
let uploading = false;
let jobVideoUrl = null;
let historyItems = null;
let historyMessage = null;
let historyTimer = null;
let skinNames = ['default'];
let skinMessage = null;
let skinBusy = false;
let presetMessage = null;
let diagnosticsReport = null;
let diagnosticsMessage = null;
let diagnosticsBusy = false;
let update = null;
let updateMessage = null;
let updateBusy = false;

// ---- storage helpers: private mode or disabled storage must never break the page ----
function storageGet(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}
function storageSet(storage, key, value) {
  try { if (value === null) storage.removeItem(key); else storage.setItem(key, value); return true; } catch { return false; }
}
function storageJson(storage, key) {
  try { return JSON.parse(storageGet(storage, key) ?? 'null'); } catch { return null; }
}

// ---- wiring ----
token.value = storageGet(sessionStorage, TOKEN_STORAGE_KEY) ?? '';
tokenField.hidden = !token.value;
token.addEventListener('change', () => {
  storageSet(sessionStorage, TOKEN_STORAGE_KEY, token.value || null);
  loadSkins(); loadHistory(); loadUpdate();
});
for (const control of optionControls) {
  control.addEventListener('input', () => { syncOutput(control); rememberOptions(); });
  control.addEventListener('change', rememberOptions);
}
drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (event) => { event.preventDefault(); drop.classList.remove('drag'); upload(event.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { const file = fileInput.files[0]; fileInput.value = ''; upload(file); });
cancelButton.addEventListener('click', cancelJob);
retryButton.addEventListener('click', () => { if (lastFile) upload(lastFile); else resetJob(); });
anotherButton.addEventListener('click', resetJob);
downloadButton.addEventListener('click', () => downloadVideo(jobId));
jobVideo.addEventListener('error', () => refreshVideoSource(jobVideo));
moreSettings.addEventListener('click', () => { drawer.showModal(); settingsSearch.focus(); });
drawerClose.addEventListener('click', () => drawer.close());
drawer.addEventListener('click', (event) => { if (event.target === drawer) drawer.close(); });
settingsSearch.addEventListener('input', filterSettings);
presetSelect.addEventListener('change', loadPreset);
presetSave.addEventListener('click', savePreset);
presetDelete.addEventListener('click', deletePreset);
presetReset.addEventListener('click', () => { applyOptions(DEFAULT_OPTIONS); presetSelect.value = ''; showPreset('presets.resetDone', {}); });
historyRefresh.addEventListener('click', () => loadHistory());
skinDrop.addEventListener('dragover', (event) => { event.preventDefault(); skinDrop.classList.add('drag'); });
skinDrop.addEventListener('dragleave', () => skinDrop.classList.remove('drag'));
skinDrop.addEventListener('drop', (event) => { event.preventDefault(); skinDrop.classList.remove('drag'); uploadSkin(event.dataTransfer.files[0]); });
skinFile.addEventListener('change', () => { const file = skinFile.files[0]; skinFile.value = ''; uploadSkin(file); });
previewClose.addEventListener('click', () => previewDialog.close());
previewDialog.addEventListener('click', (event) => { if (event.target === previewDialog) previewDialog.close(); });
previewDialog.addEventListener('close', () => { previewVideo.pause(); previewVideo.removeAttribute('src'); previewVideo.load(); });
previewVideo.addEventListener('error', () => refreshVideoSource(previewVideo));
languageSelect.addEventListener('change', () => {
  storageSet(localStorage, LANGUAGE_STORAGE_KEY, languageSelect.value);
  setLanguage(languageSelect.value);
});
diagDownload.addEventListener('click', downloadDiagnostics);
diagCopy.addEventListener('click', copyDiagnostics);
diagIssue.addEventListener('click', openIssue);
diagSend.addEventListener('click', sendDiagnostics);
updateApply.addEventListener('click', applyUpdate);
window.addEventListener('hashchange', () => showRoute(true));
// Dropping a file anywhere else would make the browser navigate away from the page.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

restoreOptions();
renderPresets();
languageSelect.value = detectLanguage();
setLanguage(languageSelect.value);
showRoute(false);
loadHealth();
setInterval(loadHealth, HEALTH_REFRESH_MS);
loadUpdate();
loadSkins();
loadHistory();
resumeJob();

// ---- routing ----
function routeFromHash() {
  const name = /^#\/([a-z]+)$/.exec(window.location.hash)?.[1];
  return ROUTES.includes(name) ? name : DEFAULT_ROUTE;
}
function showRoute(moveFocus) {
  const next = routeFromHash();
  if (next === route) return;
  route = next;
  for (const [name, view] of Object.entries(views)) view.hidden = name !== route;
  for (const tab of tabs) {
    if (tab.dataset.route === route) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
  if (route === 'history') loadHistory();
  if (route === 'skins') loadSkins();
  if (moveFocus) views[route].querySelector('h1')?.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

// ---- render options, presets ----
function renderOptions() {
  const options = {};
  for (const control of optionControls) {
    const key = control.dataset.option;
    if (control.type === 'checkbox') options[key] = control.checked;
    else if (control.type === 'range' || control.dataset.type === 'number') options[key] = Number(control.value);
    else options[key] = control.value;
  }
  return options;
}
function applyOptions(options) {
  if (!options || typeof options !== 'object') return;
  for (const control of optionControls) {
    const value = options[control.dataset.option];
    if (value === undefined) continue;
    if (control.type === 'checkbox') control.checked = value === true;
    else if (control === skinSelect) skinSelect.value = skinNames.includes(value) ? value : 'default';
    else {
      control.value = String(value);
      // An unknown <select> value leaves nothing selected: fall back to the default.
      if (control.tagName === 'SELECT' && control.selectedIndex < 0) control.value = String(DEFAULT_OPTIONS[control.dataset.option]);
    }
    syncOutput(control);
  }
  rememberOptions();
}
function syncOutput(control) {
  const output = document.querySelector(`#${control.id}Value`);
  if (output) output.value = `${control.value}${PERCENT_RANGES.includes(control.id) ? '%' : ''}`;
}
function rememberOptions() {
  storageSet(localStorage, LAST_OPTIONS_STORAGE_KEY, JSON.stringify(renderOptions()));
}
function restoreOptions() {
  const saved = storageJson(localStorage, LAST_OPTIONS_STORAGE_KEY);
  if (saved) applyOptions(saved);
  // The skin list loads later; keep the wanted skin so it can be selected once it is known.
  if (typeof saved?.skin === 'string') skinSelect.dataset.wanted = saved.skin;
}
function presets() {
  const stored = storageJson(localStorage, PRESETS_STORAGE_KEY);
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}
function renderPresets() {
  const selected = presetSelect.value;
  const names = Object.keys(presets()).sort((a, b) => a.localeCompare(b));
  const placeholder = presetSelect.options[0];
  presetSelect.replaceChildren(placeholder, ...names.map((name) => {
    const option = document.createElement('option');
    option.value = name; option.textContent = name;
    return option;
  }));
  presetSelect.value = names.includes(selected) ? selected : '';
  presetDelete.disabled = !presetSelect.value;
}
function loadPreset() {
  presetDelete.disabled = !presetSelect.value;
  const options = presets()[presetSelect.value];
  if (!options) return;
  applyOptions(options);
  showPreset('presets.applied', { name: presetSelect.value });
}
function savePreset() {
  const name = window.prompt(t('presets.namePrompt'), presetSelect.value)?.trim().slice(0, 40);
  if (!name) return;
  const all = presets();
  all[name] = renderOptions();
  if (!storageSet(localStorage, PRESETS_STORAGE_KEY, JSON.stringify(all))) { showPreset('presets.storageFailed', {}, 'error'); return; }
  renderPresets(); presetSelect.value = name; presetDelete.disabled = false;
  showPreset('presets.saved', { name });
}
function deletePreset() {
  const name = presetSelect.value;
  if (!name || !window.confirm(t('presets.confirmDelete', { name }))) return;
  const all = presets();
  delete all[name];
  storageSet(localStorage, PRESETS_STORAGE_KEY, JSON.stringify(all));
  renderPresets();
  showPreset('presets.deleted', { name });
}
function showPreset(key, vars, tone = 'ok') {
  presetMessage = { key, vars, tone }; renderPresetStatus();
}
function renderPresetStatus() {
  presetStatus.textContent = presetMessage ? t(presetMessage.key, presetMessage.vars) : '';
  presetStatus.dataset.tone = presetMessage?.tone ?? '';
}
function filterSettings() {
  const query = settingsSearch.value.trim().toLocaleLowerCase();
  let shown = 0;
  for (const fieldset of drawer.querySelectorAll('fieldset')) {
    const legendMatch = fieldset.querySelector('legend').textContent.toLocaleLowerCase().includes(query);
    let visible = 0;
    for (const setting of fieldset.querySelectorAll('.setting')) {
      const match = !query || legendMatch || setting.textContent.toLocaleLowerCase().includes(query);
      setting.hidden = !match;
      if (match) visible += 1;
    }
    fieldset.hidden = visible === 0;
    shown += visible;
  }
  settingsNoMatch.hidden = shown > 0;
  settingsNoMatch.textContent = shown > 0 ? '' : t('settings.noMatch', { query: settingsSearch.value.trim() });
}

// ---- render job ----
async function upload(file) {
  if (!file || uploading) return;
  lastFile = file;
  stopJobPolling();
  jobId = null; currentJob = null; jobProblem = null; uploading = true;
  storageSet(sessionStorage, ACTIVE_JOB_STORAGE_KEY, null);
  showJobCard(file.name);
  renderJob();
  const form = new FormData();
  form.append('options', JSON.stringify(renderOptions()));
  form.append('replay', file);
  let response = null;
  try { response = await api('/api/renders', { method: 'POST', body: form }); } catch { /* reported below */ }
  const data = response ? await readJson(response) : null;
  uploading = false;
  if (!response?.ok || typeof data?.id !== 'string') {
    jobProblem = data?.error ?? { key: 'job.uploadFailed' };
    renderJob();
    return;
  }
  jobId = data.id;
  storageSet(sessionStorage, ACTIVE_JOB_STORAGE_KEY, jobId);
  currentJob = { id: jobId, status: data.status ?? 'resolving', progress: 0 };
  renderJob();
  startJobPolling();
  loadHistory();
}
function resumeJob() {
  const stored = storageGet(sessionStorage, ACTIVE_JOB_STORAGE_KEY);
  if (!stored || !/^[a-f0-9-]{36}$/i.test(stored)) return;
  jobId = stored;
  showJobCard('');
  startJobPolling();
}
function showJobCard(fileName) {
  jobTitle.dataset.fileName = fileName;
  drop.hidden = true; jobCard.hidden = false;
}
function resetJob() {
  stopJobPolling();
  jobId = null; currentJob = null; jobProblem = null; lastFile = null;
  storageSet(sessionStorage, ACTIVE_JOB_STORAGE_KEY, null);
  setJobVideo(null);
  jobCard.hidden = true; drop.hidden = false;
  drop.focus();
}
function startJobPolling() {
  stopJobPolling();
  pollJob();
  jobTimer = setInterval(pollJob, JOB_POLL_MS);
}
function stopJobPolling() {
  clearInterval(jobTimer); jobTimer = null;
}
async function pollJob() {
  const id = jobId;
  if (!id) return;
  let response;
  try { response = await api(`/api/renders/${id}`, { cache: 'no-store' }); } catch { return; } // offline for a moment: keep polling
  const data = await readJson(response);
  if (id !== jobId) return;
  if (!response.ok || typeof data?.status !== 'string') {
    jobProblem = data?.error ?? { key: 'errors.INTERNAL_ERROR' };
    if (response.status === 404 || response.status === 401) {
      stopJobPolling();
      if (response.status === 404) storageSet(sessionStorage, ACTIVE_JOB_STORAGE_KEY, null);
    }
    renderJob();
    return;
  }
  const wasTerminal = TERMINAL_STATUSES.includes(currentJob?.status);
  currentJob = data; jobProblem = null;
  renderJob();
  if (TERMINAL_STATUSES.includes(data.status)) {
    stopJobPolling();
    if (!wasTerminal) { loadHealth(); loadHistory(); }
  }
}
async function cancelJob() {
  if (!jobId) return;
  cancelButton.disabled = true;
  try {
    const response = await api(`/api/renders/${jobId}`, { method: 'DELETE' });
    if (!response.ok) jobProblem = (await readJson(response))?.error ?? { key: 'errors.INTERNAL_ERROR' };
  } catch { jobProblem = { key: 'job.uploadFailed' }; }
  cancelButton.disabled = false;
  await pollJob();
}
function renderJob() {
  if (jobCard.hidden) return;
  const data = currentJob;
  const status = uploading ? 'uploaded' : data?.status ?? null;
  jobTitle.textContent = data?.beatmap?.title ? mapTitle(data.beatmap) : jobTitle.dataset.fileName || t('job.untitled');
  jobSub.textContent = [
    data?.beatmap?.version ? `[${data.beatmap.version}]` : null,
    data?.player ? t('job.by', { player: data.player }) : null,
    data?.mods || null,
    data?.output ? `${data.output.height}p` : null,
  ].filter(Boolean).join(' · ');
  const failed = status === 'failed' || status === 'cancelled' || (!data && Boolean(jobProblem));
  const current = status === null ? 0 : STEP_OF_STATUS[status] ?? stepBeforeFailure(data);
  steps.forEach((step, index) => {
    let state = 'todo';
    if (status === 'completed' || index < current) state = 'done';
    else if (index === current) state = failed ? 'error' : 'active';
    step.dataset.state = state;
    const label = step.querySelector('.step-label');
    const detail = STEPS[index] === 'queued' && status === 'queued' && data?.queuePosition ? ` #${data.queuePosition}` : '';
    label.textContent = t(`job.steps.${STEPS[index]}`) + detail;
    if (index === current && !failed && status !== 'completed') step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
  });
  jobStatus.textContent = status
    ? t(`status.${status}`, { position: data?.queuePosition ?? '?', progress: percent(data?.progress) }, status)
    : '';
  const rendering = status === 'rendering' || status === 'finalizing';
  progressBox.hidden = !rendering;
  const value = percent(data?.progress);
  progressFill.style.width = `${value}%`;
  progressBar.setAttribute('aria-valuenow', String(value));
  progressPercent.textContent = `${value}%`;
  progressSpeed.textContent = typeof data?.speed === 'number' ? t('job.speed', { speed: data.speed.toFixed(2) }) : '';
  progressEta.textContent = typeof data?.eta === 'string' && data.eta ? t('job.eta', { eta: data.eta }) : '';
  const problem = data?.error ?? jobProblem;
  jobError.hidden = !problem && status !== 'cancelled';
  jobErrorText.textContent = problem ? errorText(problem) : status === 'cancelled' ? t('job.cancelled') : '';
  const completed = status === 'completed' && typeof data?.previewUrl === 'string';
  jobResult.hidden = !completed;
  setJobVideo(completed ? data.previewUrl : null);
  downloadButton.hidden = !completed;
  cancelButton.hidden = !data || uploading || TERMINAL_STATUSES.includes(status);
  const retryable = Boolean(problem || status === 'cancelled') && lastFile && !FILE_ERRORS.includes(problem?.code);
  retryButton.hidden = !retryable;
  anotherButton.hidden = !(TERMINAL_STATUSES.includes(status) || (problem && !jobTimer));
}
function stepBeforeFailure(data) {
  // A failed job doesn't say where it stopped: rendering errors happened while rendering, the rest before the queue.
  if (!data) return 0;
  if (/^RENDER_/.test(data.error?.code ?? '')) return 4;
  if (data.startedAt) return 4;
  return data.beatmap ? 3 : 1;
}
function setJobVideo(url) {
  if (url === jobVideoUrl) return;
  // A new signed URL for the same video (each poll signs again) must not restart playback.
  if (url && jobVideoUrl && url.split('?')[0] === jobVideoUrl.split('?')[0]) { jobVideoUrl = url; jobVideo.dataset.id = jobId; return; }
  jobVideoUrl = url;
  if (url) { jobVideo.dataset.id = jobId; jobVideo.src = url; } else { jobVideo.removeAttribute('src'); jobVideo.load(); }
}
async function refreshVideoSource(video) {
  // Signed links expire; fetch a fresh one once per failure.
  const id = video.dataset.id;
  if (!id || video.dataset.retried === 'true') return;
  video.dataset.retried = 'true';
  const url = await freshVideoUrl(id);
  if (url) video.src = url;
}
async function freshVideoUrl(id) {
  try {
    const response = await api(`/api/renders/${id}`, { cache: 'no-store' });
    const data = await readJson(response);
    return response.ok && typeof data?.previewUrl === 'string' ? data.previewUrl : null;
  } catch { return null; }
}
async function downloadVideo(id) {
  if (!id) return;
  const url = await freshVideoUrl(id);
  if (!url) {
    if (route === 'history') await loadHistory({ code: 'RENDER_EXPIRED' });
    else { jobProblem = { code: 'RENDER_EXPIRED' }; renderJob(); }
    return;
  }
  const link = document.createElement('a');
  // The server names the file after the beatmap (Content-Disposition).
  link.href = url; link.download = '';
  document.body.append(link); link.click(); link.remove();
}
function percent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

// ---- history ----
async function loadHistory(message = null) {
  try {
    const response = await api(`/api/renders?limit=${HISTORY_LIMIT}`, { cache: 'no-store' });
    const data = await readJson(response);
    if (isUnauthorized(response, data)) { historyItems = null; historyMessage = { key: 'diagnostics.needsToken' }; }
    else if (!response.ok || !Array.isArray(data?.renders)) historyMessage = { key: 'history.failed' };
    else { historyItems = data.renders; historyMessage = message; }
  } catch { historyMessage = { key: 'history.failed' }; }
  renderHistory();
  clearTimeout(historyTimer);
  if (route === 'history' && historyItems?.some((item) => !TERMINAL_STATUSES.includes(item.status))) {
    historyTimer = setTimeout(() => loadHistory(), HISTORY_POLL_MS);
  }
}
function renderHistory() {
  historyStatus.textContent = historyMessage ? errorText(historyMessage) : '';
  historyStatus.dataset.tone = historyMessage ? 'error' : '';
  historyEmpty.hidden = !(Array.isArray(historyItems) && historyItems.length === 0);
  historyList.replaceChildren(...(historyItems ?? []).map(historyEntry));
}
function historyEntry(item) {
  const entry = document.createElement('li');
  entry.className = 'history-item card';
  entry.dataset.status = item.status;
  const head = element('div', 'history-head');
  const title = element('h2', 'history-title', mapTitle(item.beatmap));
  title.title = title.textContent;
  const badge = element('span', 'badge', t(`status.${item.status}`, { position: '?', progress: percent(item.progress) }, item.status));
  badge.dataset.status = item.status;
  head.append(title, badge);
  const sub = element('p', 'history-sub', [
    item.beatmap?.version ? `[${item.beatmap.version}]` : null, item.player, item.mods || null,
  ].filter(Boolean).join(' · '));
  const facts = element('dl', 'history-facts');
  addFact(facts, t('history.created'), formatTime(item.createdAt));
  addFact(facts, t('history.encoder'), `${item.resolution ?? ''} · ${encoderLabel(item.encoder)}`);
  if (item.renderMs) addFact(facts, t('history.renderTime'), formatDuration(item.renderMs));
  const files = element('p', 'history-files');
  if (item.error) { files.textContent = errorText(item.error); files.dataset.tone = 'error'; }
  else if (item.filesDeleted) files.textContent = t('history.deleted');
  else if (TERMINAL_STATUSES.includes(item.status) && item.expiresAt) files.textContent = t('history.expires', { time: formatTime(item.expiresAt) });
  const actions = element('div', 'history-actions');
  if (item.videoAvailable) {
    actions.append(
      button(t('history.preview'), 'btn btn-secondary btn-small', () => openPreview(item)),
      button(t('history.download'), 'btn btn-primary btn-small', () => downloadVideo(item.id)),
    );
  }
  if (TERMINAL_STATUSES.includes(item.status) && !item.filesDeleted) {
    actions.append(button(t('history.deleteFiles'), 'btn btn-ghost btn-small', () => deleteHistoryFiles(item.id)));
  }
  entry.append(head, sub, facts, files, actions);
  return entry;
}
function addFact(list, label, value) {
  if (!value) return;
  list.append(element('dt', '', label), element('dd', '', value));
}
async function openPreview(item) {
  const url = await freshVideoUrl(item.id) ?? item.previewUrl;
  if (!url) return;
  previewTitle.textContent = mapTitle(item.beatmap);
  previewVideo.dataset.id = item.id; previewVideo.dataset.retried = 'false';
  previewVideo.src = url;
  previewDialog.showModal();
}
async function deleteHistoryFiles(id) {
  if (!window.confirm(t('history.confirmDelete'))) return;
  let response;
  try { response = await api(`/api/renders/${id}/files`, { method: 'DELETE' }); } catch { response = null; }
  await loadHistory(response?.ok ? null : (response && (await readJson(response))?.error) ?? { key: 'history.failed' });
}
function mapTitle(beatmap) {
  if (!beatmap?.title) return beatmap?.id ? `#${beatmap.id}` : t('history.unknownMap');
  return beatmap.artist ? `${beatmap.artist} - ${beatmap.title}` : beatmap.title;
}
function formatTime(value) {
  return typeof value === 'number' ? new Date(value).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';
}
function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// ---- skins ----
async function loadSkins() {
  let names = [];
  let loaded = false;
  try {
    const response = await api('/api/skins', { cache: 'no-store' });
    const data = await readJson(response);
    loaded = response.ok && Array.isArray(data?.skins);
    if (loaded) names = data.skins.map((skin) => skin?.name).filter((name) => typeof name === 'string');
  } catch { /* keep the built-in default only */ }
  skinNames = ['default', ...names.filter((name) => name !== 'default')];
  const wanted = skinSelect.dataset.wanted ?? skinSelect.value;
  skinSelect.replaceChildren(...skinNames.map((name) => {
    const option = document.createElement('option');
    option.value = name;
    if (name === 'default') { option.dataset.i18n = 'settings.skin.default'; option.textContent = t('settings.skin.default'); } else option.textContent = name;
    return option;
  }));
  skinSelect.value = skinNames.includes(wanted) ? wanted : 'default';
  // Keep waiting for the wanted skin while the list can't load (missing token, server down).
  if (loaded && skinSelect.dataset.wanted !== undefined) { delete skinSelect.dataset.wanted; rememberOptions(); }
  renderSkins();
}
function renderSkins() {
  skinList.replaceChildren(...skinNames.map((name) => {
    const entry = element('li', 'skin-item card');
    const selected = skinSelect.value === name;
    entry.dataset.selected = String(selected);
    const label = element('span', 'skin-name', name === 'default' ? t('settings.skin.default') : name);
    label.title = label.textContent;
    const action = button(selected ? t('skins.inUse') : t('skins.use'), selected ? 'btn btn-ghost btn-small' : 'btn btn-secondary btn-small', () => {
      skinSelect.value = name; rememberOptions(); renderSkins();
      showSkin({ key: 'skins.selected', vars: { name: label.textContent } }, 'ok');
    });
    action.setAttribute('aria-pressed', String(selected));
    entry.append(label, action);
    return entry;
  }));
}
async function uploadSkin(file) {
  if (!file || skinBusy) return;
  if (!file.name.toLowerCase().endsWith('.osk')) { showSkin({ code: 'SKIN_INVALID' }, 'error'); return; }
  skinBusy = true; skinDrop.setAttribute('aria-busy', 'true');
  showSkin({ key: 'skins.uploading' }, 'info');
  try {
    const form = new FormData();
    form.append('skin', file);
    const response = await api('/api/skins', { method: 'POST', body: form });
    const data = await readJson(response);
    if (!response.ok || typeof data?.name !== 'string') { showSkin(data?.error ?? { key: 'skins.failed' }, 'error'); return; }
    skinSelect.dataset.wanted = data.name;
    await loadSkins();
    rememberOptions();
    showSkin({ key: 'skins.installed', vars: { name: data.name } }, 'ok');
  } catch {
    showSkin({ key: 'skins.failed' }, 'error');
  } finally { skinBusy = false; skinDrop.setAttribute('aria-busy', 'false'); }
}
function showSkin(problem, tone) {
  skinMessage = { problem, tone }; renderSkinStatus();
}
function renderSkinStatus() {
  skinStatus.textContent = skinMessage ? errorText(skinMessage.problem) : '';
  skinStatus.dataset.tone = skinMessage?.tone ?? '';
}

// ---- health, diagnostics ----
async function loadHealth() {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    const data = await response.json();
    if (data?.status !== 'ok' && data?.status !== 'degraded') return;
    health = data; renderHealth();
  } catch { /* informational only: keep the last known state */ }
}
function encoderLabel(encoder) {
  if (typeof encoder !== 'string' || encoder === 'unknown') return t('encoder.unknown');
  const family = ENCODER_FAMILIES.find(([pattern]) => pattern.test(encoder))?.[1];
  return family ? t(`encoder.${family}`, {}, encoder) : encoder;
}
function encoderKind() {
  return health.encoderKind ?? (health.encoder === 'libx264' ? 'software' : health.encoder === 'unknown' ? 'none' : 'hardware');
}
function renderHealth() {
  if (!health) return;
  const kind = encoderKind();
  rendererLabel.textContent = kind === 'hardware' || kind === 'software'
    ? t('renderer.chip', { kind: t(`renderer.kind.${kind}`), encoder: encoderLabel(health.encoder) })
    : t('renderer.none');
  const reason = health.status === 'degraded' && typeof health.reason === 'string' ? t(`reason.${health.reason}`, {}, health.reason) : '';
  rendererReason.textContent = reason; rendererReason.hidden = !reason;
  rendererStatus.title = reason;
  rendererStatus.dataset.state = health.status;
  rendererStatus.hidden = false;
  const reporting = health.reportWebhook === true;
  diagSend.hidden = !reporting; diagAutoSend.hidden = !reporting; diagPrivacy.hidden = reporting;
  diagDownload.classList.toggle('btn-primary', !reporting);
  diagDownload.classList.toggle('btn-secondary', reporting);
  renderFacts();
}
function renderFacts() {
  if (!health) return;
  const facts = [
    [t('diagnostics.renderer.status'), health.status === 'ok' ? t('diagnostics.renderer.ok') : t('diagnostics.renderer.degraded')],
    [t('diagnostics.renderer.encoder'), health.encoder === 'unknown' ? t('renderer.none') : `${encoderLabel(health.encoder)} (${health.encoder})`],
    [t('diagnostics.renderer.display'), health.display ? t('diagnostics.renderer.available') : t('diagnostics.renderer.unavailable')],
    [t('diagnostics.renderer.platform'), health.platform ?? ''],
    [t('diagnostics.renderer.queue'), String(health.queue ?? 0)],
    [t('diagnostics.renderer.disk'), formatBytes(health.freeDiskBytes)],
  ];
  if (health.status === 'degraded' && health.reason) facts.push([t('diagnostics.renderer.reason'), t(`reason.${health.reason}`, {}, health.reason)]);
  rendererFacts.replaceChildren(...facts.flatMap(([label, value]) => [element('dt', '', label), element('dd', '', value)]));
  rendererFacts.dataset.state = health.status;
}
function renderProbes() {
  const probes = Array.isArray(diagnosticsReport?.encoderProbes) && diagnosticsReport.encoderProbes.length
    ? diagnosticsReport.encoderProbes : diagnosticsReport?.preflight?.probes ?? [];
  probesEmpty.hidden = probes.length > 0;
  probeList.replaceChildren(...probes.filter((probe) => typeof probe?.encoder === 'string').map((probe) => {
    const entry = element('li', 'probe');
    entry.dataset.ok = String(probe.ok === true);
    entry.append(
      element('span', 'probe-name', `${encoderLabel(probe.encoder)} · ${probe.encoder}`),
      element('span', 'badge', probe.ok ? t('diagnostics.renderer.probeOk') : t('diagnostics.renderer.probeFailed')),
    );
    return entry;
  }));
}
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
async function fetchDiagnostics() {
  if (diagnosticsBusy) return null;
  setDiagnosticsBusy(true); showDiagnostics('diagnostics.loading', 'info');
  try {
    const response = await api('/api/diagnostics', { cache: 'no-store' });
    const report = await readJson(response);
    if (isUnauthorized(response, report)) { showDiagnostics('diagnostics.needsToken', 'error'); return null; }
    if (!response.ok || !report || typeof report !== 'object' || Array.isArray(report)) { showDiagnostics('diagnostics.failed', 'error'); return null; }
    diagnosticsReport = report; showDiagnostics(null); renderProbes();
    return report;
  } catch {
    showDiagnostics('diagnostics.failed', 'error'); return null;
  } finally { setDiagnosticsBusy(false); }
}
async function downloadDiagnostics() {
  const report = await fetchDiagnostics();
  if (!report) return;
  saveBlob(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }), `osu-render-diagnostics-${fileTimestamp(new Date())}.json`);
  showDiagnostics('diagnostics.downloaded', 'ok');
}
async function copyDiagnostics() {
  const report = diagnosticsReport ?? await fetchDiagnostics();
  if (!report) return;
  const body = report.issue?.body;
  if (typeof body !== 'string' || !body) { showDiagnostics('diagnostics.failed', 'error'); return; }
  if (await copyText(body)) { diagSummary.hidden = true; showDiagnostics('diagnostics.copied', 'ok'); return; }
  diagSummary.value = body; diagSummary.hidden = false; diagSummary.focus(); diagSummary.select();
  showDiagnostics('diagnostics.copyManual', 'error');
}
async function openIssue() {
  let report = diagnosticsReport;
  if (!report) {
    report = await fetchDiagnostics();
    if (!report) return;
    // Popup blockers drop window.open once the click's user activation has expired (slow self-tests).
    if (navigator.userActivation && !navigator.userActivation.isActive) { showDiagnostics('diagnostics.openAgain', 'info'); return; }
  }
  const url = report.issue?.url;
  if (typeof url !== 'string' || !url.startsWith(ISSUE_URL_PREFIX)) { showDiagnostics('diagnostics.noIssueLink', 'error'); return; }
  window.open(url, '_blank', 'noopener');
  showDiagnostics('diagnostics.opened', 'ok');
}
async function sendDiagnostics() {
  if (diagnosticsBusy) return;
  setDiagnosticsBusy(true); showDiagnostics('diagnostics.sending', 'info');
  try {
    const response = await api('/api/diagnostics/send', { method: 'POST' });
    const data = await readJson(response);
    if (isUnauthorized(response, data)) { showDiagnostics('diagnostics.needsToken', 'error'); return; }
    if (response.ok && data?.sent === true) { showDiagnostics('diagnostics.sent', 'ok'); return; }
    showDiagnostics(data?.error?.code === 'REPORT_WEBHOOK_DISABLED' ? 'errors.REPORT_WEBHOOK_DISABLED' : 'errors.REPORT_SEND_FAILED', 'error');
  } catch {
    showDiagnostics('errors.REPORT_SEND_FAILED', 'error');
  } finally { setDiagnosticsBusy(false); }
}
function setDiagnosticsBusy(busy) {
  diagnosticsBusy = busy;
  diagnosticsCard.setAttribute('aria-busy', String(busy));
  for (const control of [diagSend, diagDownload, diagCopy, diagIssue]) control.setAttribute('aria-disabled', String(busy));
}
function showDiagnostics(key, tone) {
  diagnosticsMessage = key ? { key, tone } : null; renderDiagnosticsStatus();
}
function renderDiagnosticsStatus() {
  diagStatus.textContent = diagnosticsMessage ? t(diagnosticsMessage.key) : '';
  diagStatus.dataset.tone = diagnosticsMessage?.tone ?? '';
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* insecure context or denied: try the legacy path */ }
  const scratch = document.createElement('textarea');
  scratch.value = text; scratch.readOnly = true; scratch.className = 'clipboard-scratch';
  document.body.append(scratch); scratch.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { scratch.remove(); }
}

// ---- in-app update ----
async function loadUpdate() {
  try {
    const response = await api('/api/update', { cache: 'no-store' });
    const data = response.ok ? await readJson(response) : null;
    if (typeof data?.current !== 'string') return;
    update = data;
  } catch { return; } // informational only
  const target = storageGet(sessionStorage, UPDATE_STORAGE_KEY);
  storageSet(sessionStorage, UPDATE_STORAGE_KEY, null);
  if (target) {
    updateMessage = update.current === target
      ? { key: 'update.done', vars: { version: target }, tone: 'ok' }
      : { key: 'update.notInstalled', vars: { version: update.current }, tone: 'error' };
  }
  renderUpdate();
}
function renderUpdate() {
  const available = update?.available === true && typeof update.latest === 'string';
  updateBanner.hidden = !available && !updateMessage;
  if (updateBanner.hidden) return;
  updateBanner.dataset.tone = updateMessage?.tone ?? 'info';
  updateBanner.setAttribute('aria-busy', String(updateBusy));
  updateTitle.textContent = available ? t('update.available', { version: update.latest, current: update.current }) : '';
  if (updateMessage?.problem) updateDetail.textContent = errorText(updateMessage.problem);
  else if (updateMessage) updateDetail.textContent = t(updateMessage.key, updateMessage.vars);
  else updateDetail.textContent = update.portable ? '' : t('update.gitHint');
  updateApply.hidden = !available || update.portable !== true;
  updateApply.setAttribute('aria-disabled', String(updateBusy));
  const notesUrl = typeof update?.notesUrl === 'string' && update.notesUrl.startsWith(ISSUE_URL_PREFIX) ? update.notesUrl : null;
  updateNotes.hidden = !available || !notesUrl;
  if (notesUrl) updateNotes.href = notesUrl;
}
async function applyUpdate() {
  if (updateBusy || update?.available !== true) return;
  if (!window.confirm(t('update.confirm', { version: update.latest }))) return;
  updateBusy = true; updateMessage = { key: 'update.downloading', vars: {}, tone: 'info' }; renderUpdate();
  let response = null;
  let data = null;
  try { response = await api('/api/update/apply', { method: 'POST' }); data = await readJson(response); } catch { /* reported below */ }
  if (!response?.ok || data?.applying !== true || typeof data.version !== 'string') {
    updateBusy = false; updateMessage = { problem: data?.error ?? { code: 'UPDATE_FAILED' }, tone: 'error' }; renderUpdate();
    return;
  }
  storageSet(sessionStorage, UPDATE_STORAGE_KEY, data.version);
  updateMessage = { key: 'update.restarting', vars: { version: data.version }, tone: 'info' }; renderUpdate();
  await waitForRestart(data.version);
}
// The server exits, start.bat installs the files and starts it again: reload once it answers as the new version
// (or answers again after having been down, so the page can show that the update was rolled back).
async function waitForRestart(version) {
  const deadline = Date.now() + UPDATE_RESTART_TIMEOUT_MS;
  let wentDown = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, UPDATE_POLL_MS));
    let up = false;
    try { up = (await fetch('/health', { cache: 'no-store' })).ok; } catch { /* still restarting */ }
    if (!up) { wentDown = true; continue; }
    let current = null;
    try { current = (await readJson(await api('/api/update', { cache: 'no-store' })))?.current ?? null; } catch { /* retry */ }
    if (wentDown || current === version) { window.location.reload(); return; }
  }
  updateBusy = false; updateMessage = { key: 'update.timeout', vars: {}, tone: 'error' }; renderUpdate();
}

// ---- i18n ----
function detectLanguage() {
  const stored = storageGet(localStorage, LANGUAGE_STORAGE_KEY);
  if (LANGUAGES.includes(stored)) return stored;
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language ?? '']) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) return 'zh-TW';
    if (lower.startsWith('es')) return 'es';
    if (lower.startsWith('en')) return 'en';
  }
  return FALLBACK_LANGUAGE;
}
async function setLanguage(language) {
  const request = ++languageRequest;
  let loaded = await loadMessages(language);
  if (!loaded && language !== FALLBACK_LANGUAGE) loaded = await loadMessages(FALLBACK_LANGUAGE);
  if (request !== languageRequest || !loaded) return; // superseded, or nothing loaded: keep the text already on screen
  messages = loaded.messages;
  document.documentElement.lang = loaded.language;
  applyTranslations();
  renderHealth(); renderJob(); renderHistory(); renderSkins(); renderSkinStatus(); renderPresetStatus();
  renderDiagnosticsStatus(); renderProbes(); renderUpdate();
  if (settingsSearch.value) filterSettings();
}
async function loadMessages(language) {
  try {
    const response = await fetch(`/i18n/${encodeURIComponent(language)}.json`);
    if (!response.ok) return null;
    const data = await response.json();
    return data && typeof data === 'object' && !Array.isArray(data) ? { language, messages: data } : null;
  } catch { return null; }
}
function lookup(key) {
  let node = messages;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}
function format(text, vars) {
  return text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
}
function t(key, vars = {}, fallback = key) {
  const text = lookup(key);
  return text === undefined ? fallback : format(text, vars);
}
function applyTranslations() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const text = lookup(node.dataset.i18n);
    if (text !== undefined) node.textContent = format(text, { n: node.dataset.i18nN });
  }
  for (const attribute of I18N_ATTRIBUTES) {
    for (const node of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
      const text = lookup(node.getAttribute(`data-i18n-${attribute}`));
      if (text !== undefined) node.setAttribute(attribute, text);
    }
  }
}
function errorText(problem) {
  if (!problem) return '';
  if (problem.key) return t(problem.key, problem.vars);
  return t(`errors.${problem.code}`, {}, problem.message ?? String(problem.code ?? ''));
}

// ---- small helpers ----
function api(url, options = {}) {
  const headers = new Headers(options.headers);
  if (token.value) headers.set('Authorization', `Bearer ${token.value}`);
  return fetch(url, { ...options, headers }).then((response) => {
    // The token field stays hidden until the server asks for one.
    if (response.status === 401 && tokenField.hidden) tokenField.hidden = false;
    return response;
  });
}
function isUnauthorized(response, data) {
  return response.status === 401 || data?.error?.code === 'UNAUTHORIZED';
}
async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, onClick) {
  const node = document.createElement('button');
  node.type = 'button'; node.className = className; node.textContent = text;
  node.addEventListener('click', onClick);
  return node;
}
function saveBlob(blob, filename) {
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
  link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function fileTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
