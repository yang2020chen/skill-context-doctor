import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { collectSkills, scanEvidence } from "./scan.js";

if (!isMainThread) {
  const skills = collectSkills(workerData.skillsDirs);
  parentPort.postMessage({ type: "progress", progress: { phase: "skills", skillCount: skills.size } });
  const stats = await scanEvidence(skills, {
    ...workerData,
    onProgress(progress) {
      parentPort.postMessage({ type: "progress", progress });
    },
  });
  parentPort.postMessage({ type: "result", skills, stats });
}

export function scanSkillsInWorker(options, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: options });
    let settled = false;
    worker.on("message", (message) => {
      if (message.type === "progress") {
        onProgress(message.progress);
        return;
      }
      if (message.type === "result") {
        settled = true;
        resolve(message);
        void worker.terminate();
      }
    });
    worker.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.on("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Skill scan worker exited before returning a result (code ${code})`));
    });
  });
}
