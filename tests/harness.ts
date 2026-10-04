// Test-only entry point: this file is never part of the deployment bundle.
import worker from "../src/index";
import { GeminiAccount } from "../src/account";
export class TestAccount extends GeminiAccount {
  constructor(
    private testState: DurableObjectState,
    env: any,
  ) {
    super(testState, env);
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/test/alarm") {
      await this.alarm();
      return new Response("ok");
    }
    if (path === "/test/storage") {
      const body = (await request.json()) as any;
      if (body.put) await this.testState.storage.put(body.put);
      if (body.delete) await this.testState.storage.delete(body.delete);
      const rows = await this.testState.storage.list();
      return Response.json(Object.fromEntries(rows));
    }
    return super.fetch(request);
  }
}
export default worker;
