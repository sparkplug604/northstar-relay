import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { readBoard } from "../server/recovery/board.js";

export default defineAction({
  description: "Read live Relay visits, blocked job, callback, current draft revision, dispatcher pins, exact suggestedAt and conflict flags.",
  schema: z.object({}),
  http: { method: "GET" },
  deferLoading: false,
  run: readBoard,
});
