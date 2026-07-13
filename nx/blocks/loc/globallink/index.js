const BATCH_NAME = 'Batch1';
const DEFAULT_DUE_DATE_DAYS = 7;
const DEFAULT_TOKEN_TTL_MS = 3600000;
const REFRESH_BUFFER_MS = 60000;
const PROCESS_POLL_MS = 2000;
const PROCESS_POLL_MAX = 60;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let token;
let tokenPolling;

function getEnvConfig(config) {
  const { env } = config;
  return {
    env,
    name: config.name || 'GlobalLink',
    endpoint: config[`${env}.endpoint`],
    oauthClient: config[`${env}.oauthClient`],
    oauthSecret: config[`${env}.oauthSecret`],
    username: config[`${env}.username`],
    password: config[`${env}.password`],
    projectId: config[`${env}.projectId`],
    fileFormatName: config[`${env}.fileFormatName`],
    sourceLanguage: config[`${env}.sourceLanguage`] || 'en-US',
    dueDateDays: Number(config[`${env}.dueDateDays`]) || DEFAULT_DUE_DATE_DAYS,
    submissionId: config[`${env}.submissionId`],
  };
}

function tokenKey(name, env) {
  return `${name.toLowerCase()}.${env}.token`;
}

function setTokenDetails(name, env, accessToken, refreshToken, expiresIn) {
  token = accessToken;
  const ttlMs = (Number(expiresIn) * 1000) || DEFAULT_TOKEN_TTL_MS;
  const expires = Date.now() + ttlMs;
  localStorage.setItem(tokenKey(name, env), JSON.stringify({
    accessToken,
    refreshToken,
    expires,
  }));
  return ttlMs;
}

function getTokenDetails(name, env) {
  const lsTokenDetails = localStorage.getItem(tokenKey(name, env));
  if (!lsTokenDetails) return {};
  try {
    return JSON.parse(lsTokenDetails);
  } catch {
    return {};
  }
}

function clearToken(name, env) {
  token = undefined;
  if (tokenPolling) {
    clearInterval(tokenPolling);
    tokenPolling = undefined;
  }
  localStorage.removeItem(tokenKey(name, env));
}

function authHeaders() {
  return {
    Authorization: `Bearer ${token}`,
    ...JSON_HEADERS,
  };
}

function basicAuthHeader(client, secret) {
  return `Basic ${btoa(`${client}:${secret}`)}`;
}

async function requestToken(endpoint, oauthClient, oauthSecret, body) {
  const opts = {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(oauthClient, oauthSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  };
  const resp = await fetch(`${endpoint}/oauth/token`, opts);
  if (!resp.ok) return null;
  return resp.json();
}

async function refreshAccessToken(name, env, endpoint, oauthClient, oauthSecret) {
  const { refreshToken: currRefreshToken } = getTokenDetails(name, env);
  if (!currRefreshToken) {
    clearToken(name, env);
    return false;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: currRefreshToken,
  });

  const json = await requestToken(endpoint, oauthClient, oauthSecret, body);
  if (!json?.access_token) {
    clearToken(name, env);
    return false;
  }

  setTokenDetails(name, env, json.access_token, json.refresh_token || currRefreshToken, json.expires_in);
  return true;
}

function refreshTheToken(name, env, endpoint, oauthClient, oauthSecret, ttlMs) {
  if (tokenPolling) clearInterval(tokenPolling);
  const interval = Math.max((ttlMs || DEFAULT_TOKEN_TTL_MS) - REFRESH_BUFFER_MS, REFRESH_BUFFER_MS);
  tokenPolling = setInterval(() => {
    refreshAccessToken(name, env, endpoint, oauthClient, oauthSecret);
  }, interval);
}

function toFileName(basePath) {
  const trimmed = (basePath || 'document').replace(/^\//, '');
  const safe = trimmed.replace(/[\\/]/g, '__') || 'document';
  return /\.[a-z0-9]+$/i.test(safe) ? safe : `${safe}.html`;
}

function dueDateMs(days) {
  return Date.now() + (days * 24 * 60 * 60 * 1000);
}

function matchUrl(urls, target) {
  const clientId = target.clientIdentifier || target.client_identifier;
  if (clientId) {
    const byClient = urls.find((url) => url.basePath === clientId);
    if (byClient) return byClient;
  }

  const docName = target.documentName || target.name || target.documentNameWithPath || '';
  return urls.find((url) => {
    const fileName = toFileName(url.basePath);
    return docName === fileName
      || docName.endsWith(`/${fileName}`)
      || docName.endsWith(`\\${fileName}`)
      || docName.includes(fileName);
  });
}

async function waitForSubmissionReady(endpoint, submissionId) {
  for (let i = 0; i < PROCESS_POLL_MAX; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await fetch(`${endpoint}/rest/v0/submissions/${submissionId}/status`, {
      headers: authHeaders(),
    });
    if (resp.ok) {
      // eslint-disable-next-line no-await-in-loop
      const json = await resp.json();
      const status = (json.status || json.submissionStatus || json.processStatus || '').toString().toUpperCase();
      if (status.includes('ERROR') || status.includes('FAIL')) return false;
      if (status.includes('READY')
        || status.includes('CREATED')
        || status.includes('IDLE')
        || status.includes('COMPLETE')
        || status === 'OK') {
        return true;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, PROCESS_POLL_MS); });
  }
  // Proceed to save even if status stays ambiguous — PD often finishes during save.
  return true;
}

async function createSubmission(conf, title, langs) {
  const body = JSON.stringify({
    name: `${title}-${Date.now()}`,
    dueDate: dueDateMs(conf.dueDateDays),
    projectId: Number(conf.projectId) || conf.projectId,
    sourceLanguage: conf.sourceLanguage,
    instructions: `DA localization project: ${title}`,
    batchInfos: [{
      targetLanguageInfos: langs.map((lang) => ({ targetLanguage: lang.code })),
      targetFormat: 'TXLF',
      name: BATCH_NAME,
    }],
    claimScope: 'LANGUAGE',
  });

  const resp = await fetch(`${conf.endpoint}/rest/v0/submissions/create`, {
    method: 'POST',
    headers: authHeaders(),
    body,
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  return json.submissionId ?? json.id ?? null;
}

async function uploadSourceFile(conf, submissionId, url) {
  const body = new FormData();
  const fileName = toFileName(url.basePath);
  const file = new Blob([url.content], { type: 'text/html' });

  body.append('file', file, fileName);
  body.append('batchName', BATCH_NAME);
  body.append('fileFormatName', conf.fileFormatName);
  body.append('clientIdentifier', url.basePath);

  const resp = await fetch(`${conf.endpoint}/rest/v0/submissions/${submissionId}/upload/source`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  if (!resp.ok) return false;

  // processId is returned asynchronously; submission-level status is polled after all uploads.
  return true;
}

async function saveAndAutostart(endpoint, submissionId) {
  const resp = await fetch(`${endpoint}/rest/v0/submissions/${submissionId}/save`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ autoStart: true }),
  });
  return resp.ok;
}

async function listTargets(endpoint, submissionId, { targetStatus, targetLanguage } = {}) {
  const reqUrl = new URL(`${endpoint}/rest/v0/targets`);
  reqUrl.searchParams.set('submissionIds', submissionId);
  reqUrl.searchParams.set('pageSize', '500');
  if (targetStatus) reqUrl.searchParams.set('targetStatus', targetStatus);
  if (targetLanguage) reqUrl.searchParams.set('targetLanguage', targetLanguage);

  const resp = await fetch(reqUrl, { headers: authHeaders() });
  if (!resp.ok) return [];
  const json = await resp.json();
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.targets)) return json.targets;
  if (Array.isArray(json?.items)) return json.items;
  return [];
}

function targetLanguageOf(target) {
  return target.targetLanguage || target.language || target.locale || target.targetLocale;
}

function isProcessed(target) {
  const status = (target.targetStatus || target.status || '').toString().toUpperCase();
  return status === 'PROCESSED' || status === 'COMPLETED' || status === 'DELIVERED';
}

export async function isConnected(config) {
  const conf = getEnvConfig(config);
  const { name, env, endpoint, oauthClient, oauthSecret } = conf;
  if (!endpoint) return false;

  const { expires, refreshToken, accessToken } = getTokenDetails(name, env);
  const notExpired = expires > Date.now() + REFRESH_BUFFER_MS;

  if (accessToken && notExpired) {
    token = accessToken;
    if (!tokenPolling) {
      refreshTheToken(name, env, endpoint, oauthClient, oauthSecret, expires - Date.now());
    }
    return true;
  }

  if (refreshToken) {
    const ok = await refreshAccessToken(name, env, endpoint, oauthClient, oauthSecret);
    if (ok) {
      const details = getTokenDetails(name, env);
      refreshTheToken(name, env, endpoint, oauthClient, oauthSecret, details.expires - Date.now());
      return true;
    }
  }

  return false;
}

export async function connect(config) {
  const conf = getEnvConfig(config);
  const {
    name, env, endpoint, oauthClient, oauthSecret, username, password,
  } = conf;

  if (!endpoint || !oauthClient || !oauthSecret || !username || !password) return false;

  const body = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
  });

  const json = await requestToken(endpoint, oauthClient, oauthSecret, body);
  if (!json?.access_token) return false;

  const ttlMs = setTokenDetails(name, env, json.access_token, json.refresh_token, json.expires_in);
  refreshTheToken(name, env, endpoint, oauthClient, oauthSecret, ttlMs);
  return true;
}

export async function sendAllLanguages(title, config, langs, urls, actions, state) {
  const { setStatus, saveState } = actions;
  const conf = getEnvConfig(config);

  if (!token) {
    const connected = await isConnected(config);
    if (!connected) {
      setStatus('Not connected to GlobalLink.');
      langs.forEach((lang) => { lang.translation.status = 'error'; });
      return;
    }
  }

  if (!conf.projectId || !conf.fileFormatName) {
    setStatus('GlobalLink projectId and fileFormatName are required.');
    langs.forEach((lang) => { lang.translation.status = 'error'; });
    return;
  }

  setStatus(`Creating GlobalLink submission for: ${title}.`);
  const submissionId = await createSubmission(conf, title, langs);
  if (!submissionId) {
    setStatus('Failed to create GlobalLink submission.');
    langs.forEach((lang) => { lang.translation.status = 'error'; });
    return;
  }

  state.config[`translation.service.${conf.env}.submissionId`] = { value: String(submissionId) };
  config[`${conf.env}.submissionId`] = String(submissionId);

  setStatus(`Uploading ${urls.length} items to GlobalLink.`);
  let accepted = 0;
  for (const url of urls) {
    setStatus(`Uploading ${url.basePath}`);
    // eslint-disable-next-line no-await-in-loop
    const ok = await uploadSourceFile(conf, submissionId, url);
    if (ok) accepted += 1;
  }

  if (accepted !== urls.length) {
    setStatus(`Uploaded ${accepted}/${urls.length} items — aborting save.`);
    langs.forEach((lang) => {
      lang.translation.sent = accepted;
      lang.translation.status = 'error';
    });
    await saveState();
    return;
  }

  setStatus('Waiting for GlobalLink to finish processing uploads.');
  await waitForSubmissionReady(conf.endpoint, submissionId);

  setStatus('Starting GlobalLink submission.');
  const started = await saveAndAutostart(conf.endpoint, submissionId);
  if (!started) {
    setStatus('Failed to save/start GlobalLink submission.');
    langs.forEach((lang) => {
      lang.translation.sent = accepted;
      lang.translation.status = 'error';
    });
    await saveState();
    return;
  }

  langs.forEach((lang) => {
    lang.translation.sent = accepted;
    lang.translation.status = 'created';
  });

  setStatus();
  await saveState();
}

export async function getStatusAll(title, config, langs, urls, actions) {
  const { setStatus, saveState } = actions;
  const conf = getEnvConfig(config);
  const submissionId = conf.submissionId;

  if (!submissionId) {
    setStatus('No GlobalLink submissionId found for this project.');
    return;
  }

  if (!token) {
    const connected = await isConnected(config);
    if (!connected) {
      setStatus('Not connected to GlobalLink.');
      return;
    }
  }

  setStatus(`Checking GlobalLink status for submission ${submissionId}.`);
  const targets = await listTargets(conf.endpoint, submissionId);
  langs.forEach((lang) => { lang.translation.translated = 0; });

  const processedByLang = {};
  targets.forEach((target) => {
    if (!isProcessed(target)) return;
    const matched = matchUrl(urls, target);
    if (!matched) return;
    const langCode = targetLanguageOf(target);
    if (!langCode) return;
    processedByLang[langCode] = (processedByLang[langCode] || 0) + 1;
  });

  langs.forEach((lang) => {
    lang.translation.translated = processedByLang[lang.code] || 0;
  });

  setStatus();
  await saveState();
}

export async function getItems(config, lang, urls) {
  const conf = getEnvConfig(config);
  const submissionId = conf.submissionId;
  if (!submissionId) return [];

  if (!token) {
    const connected = await isConnected(config);
    if (!connected) return [];
  }

  const targets = await listTargets(conf.endpoint, submissionId, {
    targetStatus: 'PROCESSED',
    targetLanguage: lang.code,
  });

  const items = [];
  for (const url of urls) {
    const target = targets.find((entry) => {
      if (!isProcessed(entry)) return false;
      const langCode = targetLanguageOf(entry);
      if (langCode && langCode !== lang.code) return false;
      return matchUrl([url], entry);
    });
    if (!target?.targetId && !target?.id) continue;

    const targetId = target.targetId || target.id;
    // eslint-disable-next-line no-await-in-loop
    const resp = await fetch(
      `${conf.endpoint}/rest/v0/submissions/${submissionId}/targets/${targetId}/download/deliverable`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) continue;
    // eslint-disable-next-line no-await-in-loop
    const blob = await resp.blob();
    items.push({ ...url, blob });
  }

  return items;
}
