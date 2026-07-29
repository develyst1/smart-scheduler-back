import { describe, expect, test } from "bun:test";
import { bookingPicker, childrenFlex, textReply } from "./line-reply";
import { t } from "./line-i18n";

describe("line-reply builders (REQ-015 / TASK-038-039)", () => {
  test("textReply keeps a language-correct back-to-menu quick reply (no dead ends)", () => {
    const th = textReply("hello", "TH");
    expect(th.quickReply?.items.at(-1)?.action).toMatchObject({
      type: "postback",
      data: "action=menu",
      label: t("btn_back", "TH"),
    });
    const en = textReply("hello", "EN");
    expect((en.quickReply?.items.at(-1)?.action as { label: string }).label).toBe(t("btn_back", "EN"));
  });

  test("bookingPicker → one postback button per booking carrying its id, plus back-to-menu", () => {
    const msg = bookingPicker(
      "pick",
      "checkin",
      [
        { id: "b1", label: "A 09:00" },
        { id: "b2", label: "B 10:00" },
      ],
      "TH",
    ) as { quickReply: { items: Array<{ action: { data: string } }> } };
    expect(msg.quickReply.items).toHaveLength(3); // 2 bookings + back-to-menu
    expect(msg.quickReply.items[0]!.action.data).toBe("action=checkin&bookingId=b1");
    expect(msg.quickReply.items[1]!.action.data).toBe("action=checkin&bookingId=b2");
  });

  test("bookingPicker clamps a long label to ≤ 20 chars (LINE quick-reply limit)", () => {
    const msg = bookingPicker("p", "leave", [{ id: "b", label: "x".repeat(40) }], "EN") as {
      quickReply: { items: Array<{ action: { label: string } }> };
    };
    expect(msg.quickReply.items[0]!.action.label.length).toBeLessThanOrEqual(20);
  });

  test("childrenFlex renders a flex bubble", () => {
    const msg = childrenFlex("kids", ["A", "B"], "TH") as { type: string; contents: { type: string } };
    expect(msg.type).toBe("flex");
    expect(msg.contents.type).toBe("bubble");
  });
});
