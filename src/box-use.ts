// What the resident asks of its box hub (box-hub.ts): send a turn to a plug, ask whether a model's box is connected,
// list the plugs on offer. The hub is looked up by resident id, as the Worker does (box-routes.ts).
import { plugOfModel } from "./box-protocol";
import { boxHub } from "./box-routes";

/** A turn to the box that serves `plug`: the box's NDJSON reply, streamed. A 503 when none is connected. */
export async function boxTurn(env: Env, residentId: string, plug: string, body: string): Promise<Response> {
  return boxHub(env, residentId).turn(plug, body);
}

/** For a model served by a box: whether one is connected for it. null for a model no box serves. */
export async function boxOnline(env: Env, residentId: string, model: string): Promise<boolean | null> {
  const plug = plugOfModel(model);
  return plug ? Boolean(await boxHub(env, residentId).online(plug)) : null;
}

/** The plugs some connected box offers. */
export async function boxPlugs(env: Env, residentId: string): Promise<string[]> {
  return boxHub(env, residentId).plugs();
}

/** The line the chat shows when a turn runs on the default model because the model's box is offline. */
export const BOX_OFFLINE_NOTICE = (model: string) => `${model} 的盒子不在线，这一轮用默认模型回的`;
