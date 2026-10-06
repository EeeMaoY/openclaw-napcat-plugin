import assert from "node:assert/strict";
import test from "node:test";

import {
  beginNapCatGroupReplyContext,
  getNapCatGroupReplyMessageId,
  getNapCatGroupReplyMentionUser,
} from "../dist/src/runtime.js";

// Entries now live until they expire rather than until the webhook handler returns, and the
// store is module-level state shared by every test in this file. Each test therefore takes its
// own group id, and assertions are written so they do not depend on a cleared store.
const SENDER = "222222222";

test("a registered group message resolves to its own id and sender", () => {
  const group = "256807830";
  beginNapCatGroupReplyContext(group, SENDER, "111111");
  assert.equal(getNapCatGroupReplyMessageId(group), "111111");
  assert.equal(getNapCatGroupReplyMentionUser(group), SENDER);
});

test("the newest registered message wins while several are pending", () => {
  const group = "256807831";
  beginNapCatGroupReplyContext(group, SENDER, "111111");
  assert.equal(getNapCatGroupReplyMessageId(group), "111111");

  beginNapCatGroupReplyContext(group, SENDER, "222222");
  assert.equal(getNapCatGroupReplyMessageId(group), "222222");
});

test("a context registered before an earlier run finished still resolves for the later run", () => {
  // The regression under queue mode "followup": the handler for message 2 returns as soon as
  // the message is enqueued, and its agent run happens only after run 1 ends. Nothing may
  // remove the entry in between, or the later run's replies go out unaddressed.
  const group = "256807832";
  beginNapCatGroupReplyContext(group, SENDER, "111111"); // message 1, run 1 starts
  beginNapCatGroupReplyContext(group, SENDER, "222222"); // message 2, handler returns now

  // run 1 finishes here -- under the old teardown its cleanup could clear the store

  assert.equal(getNapCatGroupReplyMessageId(group), "222222"); // run 2 must find message 2
  assert.equal(getNapCatGroupReplyMentionUser(group), SENDER);
});

test("contexts for different groups do not interfere", () => {
  const group = "256807833";
  const otherGroup = "1020986467";
  beginNapCatGroupReplyContext(group, SENDER, "111111");
  beginNapCatGroupReplyContext(otherGroup, SENDER, "999999");

  assert.equal(getNapCatGroupReplyMessageId(group), "111111");
  assert.equal(getNapCatGroupReplyMessageId(otherGroup), "999999");
});

test("an unknown group has no context", () => {
  assert.equal(getNapCatGroupReplyMessageId("256807899"), undefined);
  assert.equal(getNapCatGroupReplyMentionUser("256807899"), undefined);
});

test("a message without a usable id still offers its mention", () => {
  const group = "256807834";
  beginNapCatGroupReplyContext(group, SENDER, "not-a-message-id");
  assert.equal(getNapCatGroupReplyMessageId(group), undefined);
  assert.equal(getNapCatGroupReplyMentionUser(group), SENDER);
});

test("non-numeric group or sender ids register nothing", () => {
  for (const [group, sender] of [
    ["", SENDER],
    ["group:1", SENDER],
    ["256807835", ""],
    ["256807835", "not-a-qq"],
  ]) {
    assert.equal(beginNapCatGroupReplyContext(group, sender, "111111"), null);
    assert.equal(getNapCatGroupReplyMessageId(group), undefined);
  }
});
