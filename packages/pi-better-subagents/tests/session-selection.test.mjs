import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSessionByName } from '../session-selection.ts';

const attempt = (id, sessionId, name, cwd, startedAt = 1) => ({
  id, sessionId, name, cwd, startedAt, status: 'completed',
});
const local = cwd => cwd === '/project' || cwd.startsWith('/project/');

test('name selection uses the local conversation rather than a global name collision', () => {
  const records = [
    attempt('run-a', 'session-a', 'reviewer', '/other'),
    attempt('run-b', 'session-b', 'reviewer', '/project/package'),
  ];
  assert.equal(selectSessionByName(records, 'reviewer', local), 'session-b');
});

test('multiple attempts of one named conversation resolve to the native session id', () => {
  const records = [
    attempt('run-a', 'native-session', 'developer', '/project'),
    attempt('run-b', 'native-session', 'developer', '/project', 2),
  ];
  assert.equal(selectSessionByName(records, 'developer', local), 'native-session');
});

test('distinct local conversations with the same name require explicit session id', () => {
  const records = [
    attempt('run-a', 'session-a', 'reviewer', '/project'),
    attempt('run-b', 'session-b', 'reviewer', '/project/child'),
  ];
  assert.throws(() => selectSessionByName(records, 'reviewer', local), error => {
    assert.match(error.message, /Ambiguous session_name/);
    assert.match(error.message, /session_id=session-a/);
    assert.match(error.message, /session_id=session-b/);
    return true;
  });
});

test('name selection does not hide an active same-name conversation to pick a completed one', () => {
  const records = [
    attempt('run-a', 'session-a', 'worker', '/project'),
    { ...attempt('run-b', 'session-b', 'worker', '/project'), status: 'running' },
  ];
  assert.throws(() => selectSessionByName(records, 'worker', local), /Ambiguous session_name/);
});

test('missing and blank names fail without selecting a different conversation', () => {
  const records = [attempt('run-a', 'session-a', 'reviewer', '/project')];
  assert.throws(() => selectSessionByName(records, 'review', local), /No saved subagent conversation/);
  assert.throws(() => selectSessionByName(records, ' ', local), /session_name is empty/);
});
