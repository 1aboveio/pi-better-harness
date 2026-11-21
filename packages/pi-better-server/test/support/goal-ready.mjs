// Fixture readiness follows the production subscription, not control hello.
export function goalActivityWhenReady(provider, ctx, observe) {
  return new Promise((resolve, reject) => {
    let checking = false, dirty = false, finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; off();
      if (error) reject(error); else resolve(value);
    };
    const update = async () => {
      if (finished) return;
      if (checking) { dirty = true; return; }
      checking = true;
      try {
        do {
          dirty = false;
          const snapshot = await observe(ctx);
          if (snapshot.status === "rebuilding") continue;
          if (snapshot.status !== "ready") throw new Error(snapshot.reason ?? "Goal activity is unverified");
          finish(undefined, await provider.getActivity(ctx));
        } while (dirty && !finished);
      } catch (error) { finish(error); }
      finally { checking = false; }
    };
    const off = provider.onActivityChanged(() => { void update(); }, ctx);
    void update();
  });
}
