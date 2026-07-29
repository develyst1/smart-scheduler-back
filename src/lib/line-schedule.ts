// Teacher "my schedule" text renderer (REQ-016 / TASK-043) — pure (no DB / no LINE API), so it is unit-testable
// and stays bilingual via `t()`. Today shows time only; the week view prefixes the date. Long lists are capped
// so the message can't exceed LINE's size limit — the overflow count is shown.
import { t, type Lang } from "./line-i18n";
import { hhmm } from "./time";

export interface SchedRow {
  date: string;
  startTime: string;
  studentName: string;
  subjectName: string;
  status: string;
}

export function renderSchedule(rows: SchedRow[], lang: Lang, range: "today" | "week", cap = 20): string {
  const title = t(range === "week" ? "tsched_title_week" : "tsched_title_today", lang);
  if (!rows.length) return `${title}\n${t("tsched_empty", lang)}`;

  const lines = rows.slice(0, cap).map((r) => {
    const when = range === "week" ? `${r.date} ${hhmm(r.startTime)}` : hhmm(r.startTime);
    return t("tsched_row", lang, {
      when,
      student: r.studentName,
      subject: r.subjectName,
      status: t(`status_${r.status}`, lang),
    });
  });
  const more = rows.length > cap ? `\n${t("tsched_more", lang, { count: rows.length - cap })}` : "";
  return `${title}\n${lines.join("\n")}${more}`;
}
