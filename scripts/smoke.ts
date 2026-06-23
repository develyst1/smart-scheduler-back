// Manual end-to-end smoke test against a running server (bun src/index.ts).
// Run: bun scripts/smoke.ts   (mutates data — re-run `bun run db:seed` after).

const BASE = process.env.BASE ?? "http://127.0.0.1:3001";
const pad = (n: number) => String(n).padStart(2, "0");
const d = new Date();
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function j(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
}

// 1) flagship calendar — pre-composed grid
const cal = await j("GET", `/api/calendar?date=${today}&view=day`);
const day0 = cal.body.days[0];
console.log(
  `1) calendar  days=${cal.body.days.length} columns(teachers)=${day0.columns.length} slots/col=${day0.columns[0].slots.length}`,
);

let pendingId: string | undefined;
let courseBookingId: string | undefined;
let remainingBefore: number | undefined;
for (const col of day0.columns)
  for (const s of col.slots) {
    const b = s.booking;
    if (!b) continue;
    if (b.status === "PENDING") pendingId ??= b.id;
    if (b.course && b.status === "CONFIRMED" && !courseBookingId) {
      courseBookingId = b.id;
      remainingBefore = b.course.leaveRemaining;
    }
  }

// 2) confirm a PENDING booking → LINE queued/skipped
const conf = await j("PATCH", `/api/bookings/${pendingId}/status`, { action: "confirm" });
console.log(
  `2) confirm   ${conf.status} status=${conf.body.booking.status} notify=${conf.body.notification?.status} (${conf.body.notification?.reason ?? "-"})`,
);

// 3) sick-leave a course booking within quota → auto-extend + quota--
const sick = await j("PATCH", `/api/bookings/${courseBookingId}/status`, { action: "sick-leave" });
console.log(
  `3) sickleave ${sick.status} status=${sick.body.booking.status} extended=${sick.body.extended?.date} locked=${sick.body.locked} remaining ${remainingBefore}→${sick.body.course?.leaveRemaining}`,
);

// 4) create booking with a NEW student (tagged-union request) in a free slot
let slot: { teacherId: string; time: string; subjectId: string } | undefined;
for (const col of day0.columns) {
  const free = col.slots.find((s: any) => !s.booking);
  if (free && col.teacher.subjects[0]) {
    slot = { teacherId: col.teacher.id, time: free.time, subjectId: col.teacher.subjects[0].id };
    break;
  }
}
const created = await j("POST", "/api/bookings", {
  student: { name: "น้องทดสอบ", phone: "0810000000" },
  teacherId: slot!.teacherId,
  subjectId: slot!.subjectId,
  date: today,
  startTime: slot!.time,
  bookingType: "SINGLE_SESSION",
});
console.log(
  `4) create    ${created.status} newStudent="${created.body.booking?.student?.name}" slot=${slot!.time}`,
);

// 5) admin-unlock a locked course
const courses = await j("GET", "/api/courses");
const locked = courses.body.find((c: any) => c.leaveLocked);
const un = locked ? await j("PATCH", `/api/courses/${locked.id}`, { adminUnlocked: true }) : null;
console.log(
  `5) unlock    ${un?.status ?? "-"} ${locked ? `${locked.student.name} leaveLocked ${locked.leaveLocked}→${un!.body.leaveLocked}` : "no locked course"}`,
);

// 6) double-book same slot → 409 SLOT_TAKEN
const clash = await j("POST", "/api/bookings", {
  student: { name: "ชนเวลา" },
  teacherId: slot!.teacherId,
  subjectId: slot!.subjectId,
  date: today,
  startTime: slot!.time,
  bookingType: "SINGLE_SESSION",
});
console.log(`6) conflict  ${clash.status} code=${clash.body.error?.code} (expect 409 SLOT_TAKEN)`);
