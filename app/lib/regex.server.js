// A regular expression a merchant typed (a tracked metafield pattern) runs against every product
// in the shared process, so it is checked before it is stored: bounded in length, free of the
// shapes that backtrack without end, and tried once in a worker that is stopped when it takes
// too long.
import { Worker } from "node:worker_threads";

export const MAX_PATTERN_LENGTH = 200;
const PROBE_TIMEOUT_MS = 200;
// A quantified group or class that is itself quantified: (a+)+, (a|aa)*, [a-z]+*, \d+{2}.
const NESTED_QUANTIFIER = /(\([^)]*[+*][^)]*\)|\[[^\]]*\][+*]|\\[dwsDWS][+*]|\.[+*])\s*[+*{]/;
const BACKREFERENCE = /\\[1-9]/;
// Inputs that make a backtracking pattern show itself.
const PROBES = ["a".repeat(32) + "!", "a".repeat(32), "ab".repeat(16) + "c", "x".repeat(64) + "y", " ".repeat(40) + "z"];

const PROBE_SCRIPT = `
  const { parentPort, workerData } = require("node:worker_threads");
  const re = new RegExp(workerData.pattern);
  for (const s of workerData.inputs) re.test(s);
  parentPort.postMessage("ok");
`;

// Runs the pattern in a worker against the probe inputs; rejects when it does not finish in time.
function probe(pattern) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PROBE_SCRIPT, { eval: true, workerData: { pattern, inputs: PROBES } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("That pattern takes too long to check. Simplify it, for example by anchoring it with ^ and $."));
    }, PROBE_TIMEOUT_MS);
    worker.once("message", () => {
      clearTimeout(timer);
      worker.terminate();
      resolve();
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(`That pattern is not valid: ${err.message}`));
    });
  });
}

// The reason a pattern cannot be used, or null when it can.
export async function patternError(pattern) {
  const p = String(pattern || "");
  if (!p) return null;
  if (p.length > MAX_PATTERN_LENGTH) return `A pattern can have up to ${MAX_PATTERN_LENGTH} characters.`;
  try {
    new RegExp(p);
  } catch (err) {
    return `That pattern is not valid: ${err.message}`;
  }
  if (NESTED_QUANTIFIER.test(p)) return "That pattern repeats a repeated group, which can take forever to check. Simplify it.";
  if (BACKREFERENCE.test(p)) return "Backreferences (\\1) are not supported in patterns.";
  try {
    await probe(p);
  } catch (err) {
    return err.message;
  }
  return null;
}
