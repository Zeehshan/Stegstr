#!/usr/bin/env node

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const ROOT = resolve(import.meta.dirname, "..");
const RESULTS_DIR = resolve(ROOT, "benchmarks/results");
const CONFIG_PATH = resolve(ROOT, "benchmarks/nostr-public-relays.json");
const durationArg = process.argv.find((arg) => arg.startsWith("--duration-minutes="));
const durationMinutes = durationArg ? Number(durationArg.split("=")[1]) : 20;
if (!Number.isFinite(durationMinutes) || durationMinutes < 0.05) throw new Error("duration must be at least 0.05 minutes");

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
if (!Array.isArray(config.relays) || config.relays.length < 3) throw new Error("soak config must contain at least three relays");

const vite = await createServer({ root: ROOT, appType: "custom", server: { middlewareMode: true }, logLevel: "error" });
const { RelayManager } = await vite.ssrLoadModule("/src/relay.ts");
const Nostr = await vite.ssrLoadModule("/src/nostr-stub.ts");
const { validateNostrEvent } = await vite.ssrLoadModule("/src/nostr-events.ts");

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

class NetworkTarget extends EventTarget {
  online = true;
  setOnline(value) {
    this.online = value;
    this.dispatchEvent(new Event(value ? "online" : "offline"));
  }
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const nowIso = () => new Date().toISOString();
const errorMessage = (error) => error instanceof Error && error.message
  ? error.message
  : error && typeof error === "object" && typeof error.message === "string" && error.message
    ? error.message
    : "WebSocket error";
const disposableSecret = Nostr.generateSecretKey();
const disposablePubkey = Nostr.getPublicKey(disposableSecret);
const storage = new MemoryStorage();
const network = new NetworkTarget();
const receivedCounts = new Map();
const receivedByGeneration = new Map();
const errors = [];
const startedAtMs = Date.now();
const relayMetrics = Object.fromEntries(config.relays.map((relay) => [relay, {
  relay,
  connection_success: false,
  connect_time_ms: null,
  disconnects: 0,
  reconnect_success: false,
  subscription_restore: false,
  publish_ack: "not_sent",
  publish_latency_ms: null,
  receive_success: false,
  duplicate_suppressed: false,
  outbox_flush_success: false,
  errors: [],
}]));

let lastStates = {};
let baselineConnected = new Set();
let reconnectPhase = false;
let mainManager;
let unsubscribe = () => {};
let managerGeneration = 0;

function observeManager(manager) {
  return manager.subscribe((snapshot) => {
    for (const relay of snapshot.relays) {
      const metric = relayMetrics[relay.url];
      if (!metric) continue;
      const previous = lastStates[relay.url];
      const connected = relay.state === "Connected" || relay.state === "Subscribed";
      const wasConnected = previous === "Connected" || previous === "Subscribed";
      if (connected && !metric.connection_success) {
        metric.connection_success = true;
        metric.connect_time_ms = Date.now() - startedAtMs;
      }
      if (wasConnected && !connected) metric.disconnects += 1;
      if (reconnectPhase && connected && baselineConnected.has(relay.url)) metric.reconnect_success = true;
      if (reconnectPhase && connected && relay.state === "Subscribed") metric.subscription_restore = true;
      if (relay.lastError && !metric.errors.includes(relay.lastError)) metric.errors.push(relay.lastError);
      lastStates[relay.url] = relay.state;
    }
  });
}

function makeManager(relays = config.relays) {
  const generation = ++managerGeneration;
  return new RelayManager(
    relays,
    [disposablePubkey],
    (event) => {
      receivedCounts.set(event.id, (receivedCounts.get(event.id) ?? 0) + 1);
      const key = `${generation}:${event.id}`;
      receivedByGeneration.set(key, (receivedByGeneration.get(key) ?? 0) + 1);
    },
    undefined,
    (error) => errors.push(errorMessage(error)),
    {
      storage,
      storageKey: "nostr-public-soak-outbox",
      onlineTarget: network,
      isOnline: () => network.online,
      connectionTimeoutMs: 8_000,
      ackTimeoutMs: 8_000,
    },
  );
}

async function probeReceive(relay, eventId) {
  return new Promise((resolveProbe) => {
    let settled = false;
    const socket = new WebSocket(relay);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolveProbe(value);
    };
    const timer = setTimeout(() => finish(false), 10_000);
    socket.onopen = () => socket.send(JSON.stringify(["REQ", "stegstr-soak-probe", { ids: [eventId], limit: 1 }]));
    socket.onmessage = (message) => {
      try {
        const parsed = JSON.parse(String(message.data));
        if (parsed[0] === "EVENT" && parsed[2]?.id === eventId && validateNostrEvent(parsed[2]).ok) finish(true);
        if (parsed[0] === "EOSE") finish(false);
      } catch {}
    };
    socket.onerror = () => finish(false);
  });
}

async function probeReceiveWithRetry(relay, eventId) {
  for (const delay of [1_000, 3_000, 6_000]) {
    await sleep(delay);
    if (await probeReceive(relay, eventId)) return true;
  }
  return false;
}

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

async function failureProbe(relays, label) {
  const probeErrors = [];
  const probe = new RelayManager(relays, [disposablePubkey], () => {}, undefined, (error) => {
    probeErrors.push(errorMessage(error));
  }, {
    storage: null,
    onlineTarget: null,
    isOnline: () => true,
    connectionTimeoutMs: 2_000,
    baseRetryMs: 30_000,
  });
  probe.start();
  await sleep(2_500);
  const snapshot = probe.snapshot();
  probe.close();
  return { label, connected: snapshot.connected, configured: snapshot.configured, sync_state: snapshot.syncState, errors: probeErrors };
}

try {
  console.log(`[${nowIso()}] Starting public relay soak with ${config.relays.length} relays and a disposable in-memory identity.`);
  mainManager = makeManager();
  unsubscribe = observeManager(mainManager);
  mainManager.start();
  await waitFor(() => mainManager.snapshot().connected > 0, 15_000);
  await sleep(5_000);
  baselineConnected = new Set(mainManager.snapshot().relays.filter((relay) => relay.state === "Subscribed").map((relay) => relay.url));

  const firstEvent = await Nostr.finishEventAsync({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["client", "stegstr-public-relay-soak"]],
    content: "Temporary Stegstr interoperability test — disposable key, automated soak, safe to ignore.",
  }, disposableSecret);
  if (!validateNostrEvent(firstEvent).ok) throw new Error("locally signed soak event did not validate");
  const firstPublishedAt = Date.now();
  mainManager.publish(firstEvent);
  await waitFor(() => ["accepted", "rejected", "timed_out"].includes(mainManager.getPublish(firstEvent.id)?.overall), 35_000);
  await waitFor(() => (receivedCounts.get(firstEvent.id) ?? 0) > 0, 20_000);
  const firstRecord = mainManager.getPublish(firstEvent.id);
  const firstGenerationReceiveCount = receivedByGeneration.get(`1:${firstEvent.id}`) ?? 0;
  const receiveProbeResults = Object.fromEntries(await Promise.all(config.relays.map(async (relay) => [relay, await probeReceiveWithRetry(relay, firstEvent.id)])));
  for (const [relay, status] of Object.entries(firstRecord?.relays ?? {})) {
    if (!relayMetrics[relay]) continue;
    relayMetrics[relay].publish_ack = status.status;
    relayMetrics[relay].publish_latency_ms = status.status === "accepted" ? status.updatedAt - firstPublishedAt : null;
    relayMetrics[relay].receive_success = receiveProbeResults[relay] === true;
  }

  reconnectPhase = true;
  network.setOnline(false);
  await sleep(500);
  const queuedEvent = await Nostr.finishEventAsync({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["client", "stegstr-public-relay-soak"], ["scenario", "offline-outbox"]],
    content: "Temporary Stegstr offline-outbox test — disposable key, safe to ignore.",
  }, disposableSecret);
  mainManager.publish(queuedEvent);
  const persistedBeforeRestart = storage.getItem("nostr-public-soak-outbox") !== null;
  unsubscribe();
  mainManager.close();

  mainManager = makeManager();
  unsubscribe = observeManager(mainManager);
  mainManager.start();
  await sleep(500);
  network.setOnline(true);
  await waitFor(() => mainManager.snapshot().connected > 0, 20_000);
  await waitFor(() => mainManager.getPublish(queuedEvent.id)?.overall === "accepted", 40_000);
  await waitFor(() => (receivedCounts.get(queuedEvent.id) ?? 0) > 0, 20_000);
  const queuedRecord = mainManager.getPublish(queuedEvent.id);
  const persistedAfterFlush = storage.getItem("nostr-public-soak-outbox") !== null;
  for (const [relay, status] of Object.entries(queuedRecord?.relays ?? {})) {
    if (!relayMetrics[relay]) continue;
    if (status.status === "accepted") relayMetrics[relay].outbox_flush_success = true;
  }

  const oneUnavailable = await failureProbe([config.relays[0], config.relays[1], config.unavailableRelays[0]], "one relay unavailable");
  const twoUnavailable = await failureProbe([config.relays[0], config.unavailableRelays[0], config.unavailableRelays[1]], "two relays unavailable");

  const soakStart = Date.now();
  const soakEnd = soakStart + durationMinutes * 60_000;
  let maxRetryAttempt = 0;
  let maxConnected = 0;
  let minConnected = Number.POSITIVE_INFINITY;
  let samples = 0;
  while (Date.now() < soakEnd) {
    const snapshot = mainManager.snapshot();
    samples += 1;
    maxConnected = Math.max(maxConnected, snapshot.connected);
    minConnected = Math.min(minConnected, snapshot.connected);
    maxRetryAttempt = Math.max(maxRetryAttempt, ...snapshot.relays.map((relay) => relay.retryAttempt));
    const remainingSeconds = Math.max(0, Math.ceil((soakEnd - Date.now()) / 1000));
    if (samples === 1 || samples % 12 === 0) console.log(`[${nowIso()}] soak: ${remainingSeconds}s remaining, ${snapshot.connected}/${snapshot.configured} connected`);
    await sleep(Math.min(5_000, Math.max(0, soakEnd - Date.now())));
  }

  const finalSnapshot = mainManager.snapshot();
  const duplicateCount = firstGenerationReceiveCount;
  const acceptedRelayCount = Object.values(firstRecord?.relays ?? {}).filter((status) => status.status === "accepted").length;
  const relayReceiveCount = Object.values(receiveProbeResults).filter(Boolean).length;
  for (const metric of Object.values(relayMetrics)) metric.duplicate_suppressed = duplicateCount === 1 && relayReceiveCount >= 2 && metric.receive_success;

  const result = {
    schema_version: 1,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: nowIso(),
    duration_minutes_requested: durationMinutes,
    duration_minutes_observed: Number(((Date.now() - startedAtMs) / 60_000).toFixed(2)),
    identity: { disposable: true, public_key: disposablePubkey, private_key_recorded: false },
    published_event_count: 2,
    first_event_id: firstEvent.id,
    offline_outbox_event_id: queuedEvent.id,
    first_publish_overall: firstRecord?.overall ?? "missing",
    first_event_receive_count_after_shared_dedup: duplicateCount,
    relays_confirming_first_event: relayReceiveCount,
    offline_outbox: {
      persisted_before_restart: persistedBeforeRestart,
      accepted_after_restart: queuedRecord?.overall === "accepted",
      removed_after_acceptance: !persistedAfterFlush,
    },
    failure_scenarios: [oneUnavailable, twoUnavailable],
    soak: {
      samples,
      min_connected: Number.isFinite(minConnected) ? minConnected : 0,
      max_connected: maxConnected,
      max_retry_attempt: maxRetryAttempt,
      final_snapshot: finalSnapshot,
    },
    relays: Object.values(relayMetrics),
    errors: [...new Set(errors)],
    sleep_wake: { automated: false, reason: "Automated system sleep is unsafe for an unattended test run; manual steps are documented in the Markdown report." },
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(resolve(RESULTS_DIR, "nostr-public-relay-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  const csvHeader = "relay,connection_success,connect_time_ms,disconnects,reconnect_success,subscription_restore,publish_ack,publish_latency_ms,receive_success,duplicate_suppressed,outbox_flush_success,errors";
  const csvRows = result.relays.map((metric) => [
    metric.relay, metric.connection_success, metric.connect_time_ms ?? "", metric.disconnects,
    metric.reconnect_success, metric.subscription_restore, metric.publish_ack, metric.publish_latency_ms ?? "",
    metric.receive_success, metric.duplicate_suppressed, metric.outbox_flush_success,
    JSON.stringify(metric.errors.join(" | ")),
  ].join(","));
  await writeFile(resolve(RESULTS_DIR, "nostr-public-relay-results.csv"), `${csvHeader}\n${csvRows.join("\n")}\n`);
  const rows = result.relays.map((metric) => `| ${metric.relay} | ${metric.connection_success} | ${metric.connect_time_ms ?? "—"} | ${metric.publish_ack} | ${metric.publish_latency_ms ?? "—"} | ${metric.receive_success} | ${metric.reconnect_success} | ${metric.outbox_flush_success} |`).join("\n");
  const markdown = `# Nostr public relay soak\n\nRun: ${result.started_at} to ${result.finished_at} (${result.duration_minutes_observed} minutes observed; ${durationMinutes} minute steady-state target).\n\nThe identity was generated only for this run. Its private key remained in memory and was neither printed nor recorded. Two harmless, clearly labeled events were published.\n\n| Relay | Connected | Connect ms | ACK | Publish ms | Received | Reconnected | Outbox flushed |\n|---|---:|---:|---|---:|---:|---:|---:|\n${rows}\n\nShared-path receive count for the first event: **${duplicateCount}**. Accepted relay count: **${acceptedRelayCount}**.\n\nOffline restart/outbox: persisted=${persistedBeforeRestart}, accepted after restart=${queuedRecord?.overall === "accepted"}, removed=${!persistedAfterFlush}.\n\nFailure scenarios:\n\n- One unavailable: ${oneUnavailable.connected}/${oneUnavailable.configured} connected, state ${oneUnavailable.sync_state}.\n- Two unavailable: ${twoUnavailable.connected}/${twoUnavailable.configured} connected, state ${twoUnavailable.sync_state}.\n\n## Sleep/wake manual procedure\n\n1. Launch the desktop app with a disposable Nostr identity and Network ON.\n2. Wait for at least one relay to complete EOSE and note the connected count.\n3. Put macOS to sleep from the Apple menu; wait at least 60 seconds.\n4. Wake and unlock the Mac.\n5. Confirm relays reconnect, subscriptions return, and a queued disposable event is accepted once.\n6. Leave the app open for five minutes and confirm relay/socket counts remain bounded and no duplicate subscriptions or retry storms appear.\n\n## Notes\n\n- Public relay behavior is policy-dependent; a missing or rejected ACK is recorded rather than treated as an architectural failure.\n- Automated system sleep was not attempted because suspending the host during an unattended tool run is unsafe.\n`;
  await writeFile(resolve(RESULTS_DIR, "nostr-public-relay-results.md"), markdown);
  console.log(`[${nowIso()}] Results written without recording the disposable private key.`);
} finally {
  unsubscribe();
  mainManager?.close();
  disposableSecret.fill(0);
  await vite.close();
}
