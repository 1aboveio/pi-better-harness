// Generated fixed launch domain from packages/pi-better-subagents/shared-operation-coordinator/src/upgrade.ts. Do not edit directly.
/** Persistent admission fence also enforced against older bundled writers. */
export function setUpgradeFence(ctx, epoch) {
    ctx.transaction(() => {
        ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS runtime_upgrade_admission_v1 BEFORE INSERT ON operations
          WHEN EXISTS (SELECT 1 FROM coordinator_state WHERE key='runtime-upgrade-fence-v1')
          AND NOT EXISTS (SELECT 1 FROM operations WHERE operation_id=NEW.operation_id)
          AND NOT (NEW.owner_kind='worker-conversation' AND EXISTS (
            SELECT 1 FROM assignment_bindings b JOIN assignment_attempts a USING(assignment_id)
            WHERE json_extract(b.owner_json, '$.kind')=NEW.owner_kind
              AND json_extract(b.owner_json, '$.sessionId')=NEW.owner_session_id
              AND json_extract(b.owner_json, '$.workspace')=NEW.owner_workspace
              AND json_extract(b.owner_json, '$.branchId') IS NEW.owner_branch_id
              AND json_extract(b.owner_json, '$.goalId') IS NEW.owner_goal_id
              AND NOT EXISTS (SELECT 1 FROM assignment_outcomes o WHERE o.assignment_id=b.assignment_id)))
          BEGIN SELECT RAISE(ABORT, 'runtime-draining: new execution deferred for upgrade'); END`);
        if (epoch === null)
            ctx.db.prepare("DELETE FROM coordinator_state WHERE key='runtime-upgrade-fence-v1'").run();
        else
            ctx.db.prepare("INSERT OR REPLACE INTO coordinator_state VALUES ('runtime-upgrade-fence-v1', ?)").run(epoch);
    });
}
