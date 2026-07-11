import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { mouse, keyboard, Point, Button, Key } from "@nut-tree/nut-js";
import screenshotDesktop from "screenshot-desktop";

function resolveKey(name: string): Key {
  const value = (Key as unknown as Record<string, Key>)[name];
  if (value === undefined) {
    throw new Error(`Unknown key "${name}". Use nut.js Key enum names, e.g. "LeftControl", "Enter", "A".`);
  }
  return value;
}

export function createComputerUseTools() {
  const screenshot = defineTool({
    name: "computer_screenshot",
    label: "Screenshot",
    description: "Capture a screenshot of the primary display.",
    parameters: Type.Object({}),
    execute: async () => {
      const buffer = (await screenshotDesktop({ format: "png" })) as Buffer;
      return {
        content: [{ type: "image", data: buffer.toString("base64"), mimeType: "image/png" }],
        details: {},
      };
    },
  });

  const moveMouse = defineTool({
    name: "computer_move_mouse",
    label: "Move Mouse",
    description: "Move the mouse cursor to an absolute screen position.",
    parameters: Type.Object({
      x: Type.Number({ description: "X coordinate in pixels" }),
      y: Type.Number({ description: "Y coordinate in pixels" }),
    }),
    execute: async (_toolCallId, params) => {
      await mouse.setPosition(new Point(params.x, params.y));
      return { content: [{ type: "text", text: `Moved mouse to (${params.x}, ${params.y}).` }], details: {} };
    },
  });

  const click = defineTool({
    name: "computer_click",
    label: "Click",
    description: "Click the mouse, optionally moving to a position first.",
    parameters: Type.Object({
      x: Type.Optional(Type.Number({ description: "X coordinate to move to before clicking" })),
      y: Type.Optional(Type.Number({ description: "Y coordinate to move to before clicking" })),
      button: Type.Optional(
        Type.Union([Type.Literal("left"), Type.Literal("right")], { default: "left" }),
      ),
      doubleClick: Type.Optional(Type.Boolean({ default: false })),
    }),
    execute: async (_toolCallId, params) => {
      if (params.x !== undefined && params.y !== undefined) {
        await mouse.setPosition(new Point(params.x, params.y));
      }
      const btn = params.button === "right" ? Button.RIGHT : Button.LEFT;
      if (params.doubleClick) {
        await mouse.doubleClick(btn);
      } else {
        await mouse.click(btn);
      }
      return { content: [{ type: "text", text: "Clicked." }], details: {} };
    },
  });

  const type = defineTool({
    name: "computer_type",
    label: "Type Text",
    description: "Type a string of text via the keyboard.",
    parameters: Type.Object({ text: Type.String({ description: "Text to type" }) }),
    execute: async (_toolCallId, params) => {
      await keyboard.type(params.text);
      return { content: [{ type: "text", text: "Typed." }], details: {} };
    },
  });

  const keyPress = defineTool({
    name: "computer_key_press",
    label: "Key Press",
    description:
      'Press and release a key combination, e.g. ["LeftControl", "C"] to copy. Key names match nut.js\'s Key enum (e.g. "Enter", "Escape", "Tab", "LeftControl", "LeftAlt", "LeftShift", "A"-"Z").',
    parameters: Type.Object({ keys: Type.Array(Type.String(), { minItems: 1 }) }),
    execute: async (_toolCallId, params) => {
      const resolved = params.keys.map(resolveKey);
      await keyboard.pressKey(...resolved);
      await keyboard.releaseKey(...resolved);
      return { content: [{ type: "text", text: `Pressed ${params.keys.join("+")}.` }], details: {} };
    },
  });

  return [screenshot, moveMouse, click, type, keyPress];
}
