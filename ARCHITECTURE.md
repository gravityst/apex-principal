# APEX: Principal — Architecture

**Engine:** none. Vanilla ES modules, Canvas 2D, no build step, no dependencies, no CDN.
**Inherited from APEX F1:** `src/data/circuits.js` (circuit geometry, turns, DRS, pit lane) and `src/data/teams.js` (ten constructors, twenty drivers, tyre compounds), unchanged.

Everything under `src/mgmt/` is pure: no DOM, no globals, no side effects at import time. That is what lets the same code run in the browser and under `node tools/*.mjs`, and it is what makes the balance harness trustworthy.

## Layers

```
src/data/        circuits.js, teams.js          — inherited data, never mutated
src/mgmt/        the simulation                 — pure, runs under node
src/race3d/      the 3D view                    — three.js, browser only
src/ui/          screens                        — DOM only, no game logic
src/principal.js application shell              — routing and the save
vendor/three/    three.js r185 + BufferGeometryUtils, vendored
```

The dependency arrow only ever points `ui → mgmt → data`. No module in `mgmt/` imports from `ui/`.

## The simulation, in dependency order

| Module | Responsibility |
|---|---|
| `rng.js` | Seeded mulberry32. Every random draw in the game comes from here. |
| `track.js` | Rebuilds a circuit's centreline from its Catmull-Rom control points; produces an arc-length table with curvature, gradient and width, plus a normalised polyline for the map. |
| `carspec.js` | Eight development levels (0–100) → physical parameters in SI units. |
| `laptime.js` | **The arbiter.** Quasi-steady-state lap solver. Also `lapModel()` (fuel and grip sensitivities) and `areaValue()` (what each department is worth here). |
| `personnel.js` | Driver pace, tyre usage, order compliance, staff, regens. |
| `facilities.js` | Seven facilities, development multipliers, pit stop times. |
| `finance.js` | Budget cap, sponsors and clauses, prize money, dismissal threshold. |
| `rnd.js` | Cost curves, delivery outcomes, development advice. Applied identically to all ten teams. |
| `rivals.js` | Rival doctrines, budgets, allocation, off-season. **Reads nothing about the player.** |
| `calendar.js` | Ten rounds over five circuits, points, weather profiles. |
| `raceengine.js` | Practice, qualifying, and a time-stepped race. |
| `state.js` | The save object, money helpers, persistence. |
| `strategy.js` | Tyre outlook, pit cost, rejoin projection, undercut maths, the push trade-off, and the engineer's proactive calls. |
| | Also in `raceengine.js`: per-car `strategyMode` (`auto` = his own engineer, `manual` = you), `overrideUntilLap` so any command you give holds the engineer off for three laps, an ERS store, interpolated sector splits, and `currentSpeed()` read from the solved profile. |
| `season.js` | Round and season progression; the headless entry points. |

## The lap solver

`solveLap(track, phys, cond)` is the standard three-pass solution for a closed circuit:

1. **Limit pass** — the cornering speed each sample can hold, from the local radius against a friction budget that *grows with speed*, because downforce grows with speed:

   ```
   m·v²/R = μ·(m·g + ½·ρ·CL·A·v²)
   ```

   If the denominator goes non-positive the corner is aero-limited and taken flat.

2. **Backward pass** — walk the lap in reverse applying the braking limit, so every corner pulls its braking zone back up the straight.

3. **Forward pass** — walk it forwards applying the lesser of the traction limit and the power limit.

Both passes respect a **friction ellipse**: a car already using grip to turn has less left for accelerating or braking. That single term is why downforce is worth 0.35 s per +10 at Monsoon Valley and 0.11 s at Crimson Flats, and it is emergent rather than authored.

The lap is a ring, so the passes are iterated until the start/finish speed settles. The ERS store is allocated on a second pass to the points where the car is power-limited rather than traction-limited, lowest speed first.

### Calibration

The solver is honest about *relative* effects, but its absolute level depends on choices like the rear traction share. Each circuit is therefore anchored to the lap record APEX F1 has on its books: a reference car is solved once per circuit and a single multiplier is stored on the track object. Calibration factors land between 1.18 and 1.35 — the street circuit needs the most, which is what you would expect.

### Sensitivities

A race is 20 cars × 60 laps. Re-solving a full lap for each would be wasteful, so `lapModel()` finite-differences the two things that change every lap — fuel burning off and grip falling away — and the race engine works in linear terms from there. The error is a few thousandths of a second.

## The race

`raceengine.js` steps in 0.25 s slices of race time. Each car's progress per slice is `dt / currentLapTime(car)`, and `currentLapTime` composes:

```
model.at(fuel, tyreGrip)                     the solved lap at this state
  − (driverPace − 1) × model.perGripLoss     the driver, through this circuit's own sensitivity
  ± ERS mode
  × safety car factor
```

Driver pace is expressed as *the fraction of the car's grip the driver actually uses*, and converted to time through the circuit's measured grip sensitivity. Applying it as a flat percentage instead made the field three times too spread out — a bug worth naming, because it is not obvious.

Positions come from `distance`, except for cars that have taken the flag: they have all covered the same distance, so they are ranked by **when** they took it. Sorting finished cars by distance scrambles the result completely (grid-to-finish correlation fell to 0.03), which is how that bug was found.

Overtaking is resolved once per pass through a DRS zone, not per tick, and only when the attacker is genuinely faster. A cooldown stops a pair re-litigating the same move every second.

## The 3D view

`src/race3d/carModel.js` is APEX F1's own `src/render/carModel.js`, unchanged apart from three rewritten import paths — bare specifiers (`three`, `three/addons/...`) became relative ones so the game needs no import map and no loader.

`src/race3d/scene.js` is new. APEX F1's track builder is 4,266 lines written against its own sampler, carrying scenery, weather and post-processing this game does not need, so the circuit is extruded here instead: asphalt, white lines, kerbs on the corners only, a run-off apron and a ground plane, all from `mgmt/track.js`'s centreline arrays.

Three details worth knowing:

- **Winding.** The extruded ribbons wind clockwise seen from above. Front-face culling hid the entire circuit while the cars floated over nothing — every track material is `DoubleSide`.
- **Orientation.** The panel is far wider than it is tall, so the camera rolls 90° (`state.orient === 'across'`): the track runs across the screen and the width shows road ahead instead of run-off. The camera's turn rate scales with the time compression, or at 15× the circuit swings around underneath a view that cannot keep up.
- **Interpolation, not chasing.** The simulation steps 0.25 s at a time — fourteen metres. Drawing those steps raw stutters; springing onto the newest one just turns the teleport into a lurch, because the error is a sawtooth the spring can never catch. `race.step()` records each car's `prevU` first, and the renderer draws at `lerp(prevU, u, alpha)` where `alpha` is how far the frame sits into the pending step. Frame-to-frame speed change went from a 162% 95th percentile to 0.02%. A jump over ~110 m (pit entry, recovery) resets `prevU` so the car is never interpolated sideways across the circuit.

Car state is synthesised, not simulated. A management game does not compute suspension travel, so wheel spin comes from speed, steer and body roll from local curvature, and compression from lateral load. Plausible beats absent.

`screenPositions()` projects each car into the active viewport so the DOM can hang a tag over it. In split view the same car appears in both panes, so the label pool is keyed by `id#pane` — keyed by id alone, the two panes fought over one element and the lower one lost.

## Where the design decisions live

- **No favouritism** — `rivals.js`. The file header states the rule; the code holds to it.
- **Drivers are fallible** — `rollMistake()` in `raceengine.js`, `complianceChance()` in `personnel.js`.
- **The field converges without cheating** — `costPerPoint()` in `rnd.js`, `BUDGET_CAP` in `finance.js`, `REGULATION_CHANGES` in `season.js`.
- **Circuits have character** — nowhere. It is emergent from `track.js` geometry and the friction ellipse in `laptime.js`.
- **Knowing when to push** — `strategy.js`. Nothing in it is a heuristic: every figure comes from the lap model the race engine is already using.

## Balance harness

`tools/simseason.mjs` runs N seasons with a stand-in principal (`autoSignSponsors` + `autoAllocation` in `season.js`) and reports championship spread, car-rating spread and cashflow. The targets it is tuned against:

| Measure | Target | Current |
|---|---|---|
| Grid → finish correlation | ≈ 0.7 | 0.82 |
| Pole converts to a win | ~40% | ~50% |
| Retirements per race | 1–3 | 2.2 |
| Accidents per race | ~0.5 | 0.4 |
| Wet-affected races | ~25% | 38% at Monsoon Valley |
| Fuel effect | 0.03 s/kg | 0.030 s/kg |
| A small team's climb | visible over 5–6 seasons | 8th → 4th |

## Browser storage

`localStorage`, wrapped in try/catch at every access, with the game fully functional if it is unavailable. Export to a JSON file is the reliable path and is offered in the menu.

## Conventions

- Metres, kilograms, seconds, radians, and millions of currency units.
- Lap distance is normalised `u ∈ [0, 1)` in the race engine, metres in the solver.
- Every module is side-effect free at import time except `principal.js`.
- No `console.log` in a hot path.
