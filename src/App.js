import React, { useState, useRef } from "react";
import "./styles.css";

/*
  LogMonitor
  ----------------
  React component that parses CSV or plain logs, pairs START/END by PID,
  computes durations, and flags WARNING (>5m) and ERROR (>10m).

  Uses a separate CSS file (styles.css) for styling.
*/

const WARN_SECONDS = 5 * 60;
const ERROR_SECONDS = 10 * 60;

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line) {
      rows.push(null);
      continue;
    }
    const cols = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && ch === ",") {
        cols.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    cols.push(cur);
    rows.push(cols);
  }
  return rows;
}

function looksLikeHeader(cols) {
  if (!cols) return false;
  const s = cols.join("|").toLowerCase();
  return (
    /time|timestamp/.test(s) && /pid/.test(s) && /status|start|end/.test(s)
  );
}

function parseLineFlexible(line) {
  const t = line.match(/(\d{2}:\d{2}:\d{2})/);
  const p = line.match(/\b(\d{1,})\b/);
  const s = line.match(/\b(START|END)\b/i);
  if (!t || !p || !s) return null;
  const time = t[1];
  const pid = p[1];
  const status = s[1].toUpperCase();
  let desc = line.replace(time, "").replace(pid, "").replace(s[1], "").trim();
  desc = desc.replace(/^[-:|,]+|[-:|,]+$/g, "").trim();
  return { time, pid, status, desc, raw: line };
}

function hhmmssToSeconds(t) {
  const [h, m, s] = t.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

function niceDuration(sec) {
  if (sec == null) return "-";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function analyzeLogText(text) {
  const csvRows = parseCsv(text);
  let rows = csvRows.filter((r) => r !== null);
  let header = null;
  if (rows.length > 0 && looksLikeHeader(rows[0])) {
    header = rows.shift().map((h) => h.trim().toLowerCase());
  }

  const entries = [];
  if (header) {
    const findIndex = (needle) => header.findIndex((h) => h.includes(needle));
    for (const cols of rows) {
      if (!cols || cols.length === 0) continue;
      const timeIdx =
        findIndex("time") >= 0 ? findIndex("time") : findIndex("timestamp");
      const pidIdx = findIndex("pid");
      let statusIdx = header.findIndex(
        (h) =>
          h.includes("status") || h.includes("action") || h.includes("state")
      );
      if (statusIdx === -1)
        statusIdx = header.findIndex((h) => /start|end/.test(h));
      let descIdx = header.findIndex(
        (h) =>
          h.includes("desc") ||
          h.includes("description") ||
          h.includes("message") ||
          h.includes("job")
      );

      if (timeIdx === -1 || pidIdx === -1 || statusIdx === -1) {
        const line = cols.join(",");
        const parsed = parseLineFlexible(line);
        if (parsed) entries.push(parsed);
        continue;
      }

      const time = (cols[timeIdx] || "").trim();
      const pid = (cols[pidIdx] || "").trim();
      const status = (cols[statusIdx] || "").trim().toUpperCase();
      const desc =
        descIdx >= 0 && cols[descIdx]
          ? cols[descIdx].trim()
          : cols.join(" ").trim();

      if (!time || !pid || !/START|END/i.test(status)) {
        const parsed = parseLineFlexible(cols.join(","));
        if (parsed) entries.push(parsed);
        continue;
      }

      entries.push({ time, pid, status, desc, raw: cols.join(",") });
    }
  } else {
    const original = text.split(/\r?\n/);
    for (const line of original) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const csvTry = parseCsv(line)[0];
      let parsed = null;
      if (csvTry && csvTry.length > 1)
        parsed = parseLineFlexible(csvTry.join(","));
      else parsed = parseLineFlexible(line);
      if (parsed) entries.push(parsed);
    }
  }

  const startsByPid = {};
  const completed = [];
  const orphans = [];

  entries.forEach((e, idx) => {
    if (!e || !e.time || !e.pid || !e.status) return;
    if (e.status === "START") {
      if (!startsByPid[e.pid]) startsByPid[e.pid] = [];
      startsByPid[e.pid].push({ time: e.time, desc: e.desc, raw: e.raw, idx });
    } else if (e.status === "END") {
      const stack = startsByPid[e.pid];
      if (stack && stack.length > 0) {
        const start = stack.pop();
        let dur = hhmmssToSeconds(e.time) - hhmmssToSeconds(start.time);
        if (dur < 0) dur += 24 * 3600;
        completed.push({
          pid: e.pid,
          desc: start.desc || e.desc,
          start_time: start.time,
          end_time: e.time,
          duration_s: dur,
          raw_start: start.raw,
          raw_end: e.raw,
        });
      } else {
        orphans.push({
          pid: e.pid,
          desc: e.desc,
          end_time: e.time,
          raw: e.raw,
        });
      }
    }
  });

  const incompletes = [];
  Object.keys(startsByPid).forEach((pid) => {
    const stack = startsByPid[pid];
    for (const s of stack)
      incompletes.push({ pid, desc: s.desc, start_time: s.time, raw: s.raw });
  });

  for (const c of completed) {
    if (c.duration_s > ERROR_SECONDS) c.status = "ERROR";
    else if (c.duration_s > WARN_SECONDS) c.status = "WARNING";
    else c.status = "OK";
  }

  completed.sort((a, b) => {
    if (a.start_time && b.start_time)
      return a.start_time.localeCompare(b.start_time);
    if (a.end_time && b.end_time) return a.end_time.localeCompare(b.end_time);
    return a.pid.localeCompare(b.pid);
  });

  return { completed, orphans, incompletes, entries };
}

function StatusPill({ status }) {
  const base = "lm-pill";
  if (status === "OK") return <span className={`${base} ok`}>OK</span>;
  if (status === "WARNING")
    return <span className={`${base} warn`}>WARNING</span>;
  return <span className={`${base} err`}>ERROR</span>;
}

export default function LogMonitor() {
  const [text, setText] = useState("");
  const [report, setReport] = useState(null);
  const fileRef = useRef(null);

  function loadSample() {
    setText(
      [
        "time,pid,status,description",
        "12:00:00,46578,START,Job A processing",
        "12:04:00,46578,END,Job A finished",
        "12:10:00,12345,START,Job B processing",
        "12:22:00,12345,END,Job B finished",
        "23:55:00,99999,START,Night job",
        "00:10:00,99999,END,Night job finished (wrap midnight)",
        "12:30:00 55555 START AnotherJob",
        "12:38:00 55555 END AnotherJob",
      ].join("\n")
    );
  }

  async function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    setText(txt);
  }

  function onProcess() {
    if (!text.trim()) return alert("Please paste logs or upload a file first.");
    const res = analyzeLogText(text);
    setReport(res);
  }

  return (
    <div className="lm-root">
      <div className="lm-card">
        <h2>Log Monitor</h2>
        <p className="lm-muted">
          Paste a CSV or plain log below, or upload a file. Designed to be
          readable and easy to modify.
        </p>

        <div className="lm-controls">
          <input
            ref={fileRef}
            className="lm-input-file"
            type="file"
            accept=".csv,.log,.txt"
            onChange={onFile}
          />
          <button className="lm-btn" onClick={loadSample}>
            Load sample
          </button>
          <button className="lm-btn" onClick={onProcess}>
            Process
          </button>
          <button
            className="lm-btn secondary"
            onClick={() => {
              setText("");
              setReport(null);
            }}
          >
            Clear
          </button>
        </div>

        <textarea
          className="lm-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste logs here..."
        />

        {report && (
          <div style={{ marginTop: 16 }}>
            <div className="lm-stats">
              <div className="lm-stat">Total: {report.completed.length}</div>
              <div className="lm-stat">
                Warnings:{" "}
                {report.completed.filter((c) => c.status === "WARNING").length}
              </div>
              <div className="lm-stat">
                Errors:{" "}
                {report.completed.filter((c) => c.status === "ERROR").length}
              </div>
              <div className="lm-stat">
                Incomplete: {report.incompletes.length}
              </div>
              <div className="lm-stat">
                Orphan ends: {report.orphans.length}
              </div>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table className="lm-table">
                <thead>
                  <tr>
                    <th>PID</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Duration</th>
                    <th>Status</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {report.completed.map((c, i) => (
                    <tr key={i}>
                      <td>{c.pid}</td>
                      <td>{c.start_time}</td>
                      <td>{c.end_time}</td>
                      <td>{niceDuration(c.duration_s)}</td>
                      <td>
                        <StatusPill status={c.status} />
                      </td>
                      <td className="desc">{c.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {report.orphans.length > 0 && (
              <div className="lm-note warn">
                <strong>Orphan END entries:</strong>
                <ul>
                  {report.orphans.map((o, idx) => (
                    <li key={idx}>
                      PID {o.pid} at {o.end_time} — {o.raw}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.incompletes.length > 0 && (
              <div className="lm-note info">
                <strong>Incomplete START entries:</strong>
                <ul>
                  {report.incompletes.map((ic, idx) => (
                    <li key={idx}>
                      PID {ic.pid} at {ic.start_time} — {ic.raw}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

