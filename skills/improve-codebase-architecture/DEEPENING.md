# Deepening

How to deepen shallow modules safely, given dependencies. Uses [LANGUAGE.md](LANGUAGE.md) vocabulary.

## Dependency categories

When assessing a candidate for deepening, classify its dependencies. The category determines how the deepened module is tested across its seam.

### 1. In-process

Pure computation, in-memory state, no I/O. Always deepenable -- merge and test through the new interface directly. No adapter needed.

### 2. Local-substitutable

Dependencies with local test stand-ins (PGLite for Postgres, in-memory filesystem). Deepenable if the stand-in exists. Test with stand-in running in-suite; seam is internal, no external port.

### 3. Remote but owned (Ports & Adapters)

Your own services across a network boundary (microservices, internal APIs). Define a **port** at the seam. Logic sits in the deep module; transport injected as an **adapter**. Tests: in-memory adapter. Production: HTTP/gRPC/queue adapter.

### 4. True external (Mock)

Third-party services you don't control (Stripe, Twilio). Deepened module takes the dependency as an injected port; tests provide a mock adapter.

## Seam discipline

- **Adapter count determines seam reality** ([LANGUAGE.md](LANGUAGE.md) principles). Don't introduce a port unless at least two adapters are justified (typically production + test). A single-adapter seam is just indirection.
- **Internal seams vs external seams.** A deep module can have internal seams (private, used by its own tests) alongside the external seam at its interface. Don't expose internal seams through the interface.

## Testing strategy: replace, don't layer

- Old unit tests on shallow modules become waste once interface-level tests exist -- delete them.
- Write new tests at the deepened module's interface. The **interface is the test surface**.
- Tests assert on observable outcomes, not internal state.
- Tests must survive internal refactors. If a test changes when implementation changes, it's testing past the interface.
