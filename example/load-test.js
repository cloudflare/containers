// run-requests.js  (Node v18+ CommonJS)
const { performance } = require('node:perf_hooks');

const BASE = 'https://testing-load.mike-test-ent-account.workers.dev/container';
const PREFIX = 'next-test';
const START = 1;
const TOTAL = 200;
const BATCH_SIZE = 10;
const LAUNCH_SPACING_MS = 200;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function urlFor(i) {
  const id = `${PREFIX}-${i}`;
  return { id, url: `${BASE}/${encodeURIComponent(id)}` };
}

function timeNow() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function stats(nums) {
  if (!nums.length) return { meanMs: null, medianMs: null };
  const sum = nums.reduce((a, b) => a + b, 0);
  const meanMs = sum / nums.length;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return { meanMs, medianMs };
}

async function makeRequest(id, url, isFollowUp = false) {
  const launchTs = performance.now();
  const requestType = isFollowUp ? 'FOLLOW_UP' : 'INITIAL';

  console.log(`${timeNow()} - ${requestType} REQUEST: ${id} -> ${url}`);

  return new Promise((resolve) => {
    let followUpTriggered = false;

    const timeoutId = setTimeout(() => {
      const doneTs = performance.now();
      const durMs = doneTs - launchTs;
      console.log(`${timeNow()} - TIMEOUT (15s): ${id} (${requestType})`);
      resolve({ id, url, durMs, status: 'TIMEOUT', success: false, isFollowUp, timedOut: true });
    }, 15000);

    // Trigger follow-up request after 15 seconds for initial requests only
    const followUpTrigger = !isFollowUp ? setTimeout(() => {
      if (!followUpTriggered) {
        followUpTriggered = true;
        console.log(`${timeNow()} - SLOW RESPONSE (>15s): ${id} - Triggering follow-up request`);
      }
    }, 15000) : null;

    fetch(url)
      .then(async (res) => {
        clearTimeout(timeoutId);
        if (followUpTrigger) clearTimeout(followUpTrigger);
        const doneTs = performance.now();
        const durMs = doneTs - launchTs;
        const needsFollowUp = !isFollowUp && durMs > 15000 && !followUpTriggered;
        if (needsFollowUp) followUpTriggered = true;
        console.log(`${timeNow()} - RESPONSE: ${id} (${requestType}) - ${durMs.toFixed(2)}ms - Status: ${res.status}${needsFollowUp ? ' (SLOW - will trigger follow-up)' : ''}`);
        resolve({ id, url, durMs, status: res.status, success: res.ok, isFollowUp, timedOut: false, needsFollowUp });
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        if (followUpTrigger) clearTimeout(followUpTrigger);
        const doneTs = performance.now();
        const durMs = doneTs - launchTs;
        const needsFollowUp = !isFollowUp && durMs > 15000 && !followUpTriggered;
        if (needsFollowUp) followUpTriggered = true;
        console.log(`${timeNow()} - ERROR: ${id} (${requestType}) - ${durMs.toFixed(2)}ms - ${err.message}${needsFollowUp ? ' (SLOW - will trigger follow-up)' : ''}`);
        resolve({ id, url, durMs, status: 'FETCH_ERROR', success: false, isFollowUp, timedOut: false, needsFollowUp });
      });
  });
}

async function runBatch(batchStart, batchSize) {
  const tasks = [];
  const statusCounts = new Map();
  const successDurationsMs = [];
  const allDurationsMs = [];
  const followUpRequests = [];
  let successes = 0;
  let failures = 0;

  for (let i = batchStart; i < batchStart + batchSize; i++) {
    const { id, url } = urlFor(i);

    const requestPromise = makeRequest(id, url, false).then(async (result) => {
      allDurationsMs.push(result);

      if (result.timedOut || result.needsFollowUp) {
        const reason = result.timedOut ? 'TIMEOUT' : 'SLOW_RESPONSE';
        console.log(`${timeNow()} - SCHEDULING FOLLOW-UP: ${id} (${reason})`);
        const followUpResult = await makeRequest(id, url, true);
        allDurationsMs.push(followUpResult);
        followUpRequests.push(followUpResult);

        if (followUpResult.success) {
          successes++;
          successDurationsMs.push(followUpResult.durMs);
        } else {
          failures++;
          statusCounts.set(followUpResult.status, (statusCounts.get(followUpResult.status) || 0) + 1);
        }
      } else {
        if (result.success) {
          successes++;
          successDurationsMs.push(result.durMs);
        } else {
          failures++;
          statusCounts.set(result.status, (statusCounts.get(result.status) || 0) + 1);
        }
      }
    });

    tasks.push(requestPromise);
    await sleep(LAUNCH_SPACING_MS);
  }

  await Promise.allSettled(tasks);
  const { meanMs, medianMs } = stats(successDurationsMs);
  return { successes, failures, statusCounts, meanMs, medianMs, allDurationsMs, followUpRequests };
}

async function main() {
  let totalSuccesses = 0;
  let totalFailures = 0;
  let totalFollowUpRequests = 0;
  const totalStatusCounts = new Map();
  const allResponseTimes = [];

  const end = START + TOTAL;
  for (let batchStart = START; batchStart < end; batchStart += BATCH_SIZE) {
    const size = Math.min(BATCH_SIZE, end - batchStart);
    const batchIndex = Math.floor((batchStart - START) / BATCH_SIZE) + 1;

    console.log(`\n=============`);
    console.log(`BATCH ${batchIndex} START (${batchStart}-${batchStart + size - 1}) @ ${timeNow()}`);

    const t0 = performance.now();
    const { successes, failures, statusCounts, meanMs, medianMs, allDurationsMs, followUpRequests } = await runBatch(batchStart, size);
    const t1 = performance.now();

    console.log(`BATCH ${batchIndex} END   (${batchStart}-${batchStart + size - 1}) @ ${timeNow()}`);
    console.log(`Elapsed: ${(t1 - t0).toFixed(2)} ms`);
    console.log(`Successes: ${successes}`);
    console.log(`Failures:  ${failures}`);
    console.log(`Follow-up requests: ${followUpRequests.length}`);
    console.log(`Failures by code: ${
      [...statusCounts.entries()].map(([code, count]) => `${code}: ${count}`).join(', ') || 'none'
    }`);
    console.log(
      `Latency (success only): mean=${meanMs === null ? 'n/a' : meanMs.toFixed(2)} ms, ` +
      `median=${medianMs === null ? 'n/a' : medianMs.toFixed(2)} ms`
    );
    console.log(`=============`);

    totalSuccesses += successes;
    totalFailures += failures;
    totalFollowUpRequests += followUpRequests.length;
    allResponseTimes.push(...allDurationsMs);
    for (const [k, v] of statusCounts.entries()) {
      totalStatusCounts.set(k, (totalStatusCounts.get(k) || 0) + v);
    }

    // Add spacing between batch launches (except for the last batch)
    if (batchStart + BATCH_SIZE < end) {
      await sleep(LAUNCH_SPACING_MS);
    }
  }

  console.log(`\n=== OVERALL SUMMARY ===`);
  console.log(`Total requests: ${TOTAL}`);
  console.log(`Total successes: ${totalSuccesses}`);
  console.log(`Total failures:  ${totalFailures}`);
  console.log(`Total follow-up requests: ${totalFollowUpRequests}`);
  console.log(`Total failures by code: ${
    [...totalStatusCounts.entries()].map(([code, count]) => `${code}: ${count}`).join(', ') || 'none'
  }`);

  console.log(`\n=== ALL RESPONSE TIMES ===`);
  allResponseTimes
    .sort((a, b) => parseInt(a.id.split('-')[2]) - parseInt(b.id.split('-')[2]))
    .forEach(({ id, url, durMs, status, success, isFollowUp }) => {
      const requestType = isFollowUp ? ' [FOLLOW-UP]' : '';
      console.log(`${id}: ${durMs.toFixed(2)}ms (${success ? 'SUCCESS' : 'FAILED'} - ${status})${requestType} - ${url}`);
    });
}

main();