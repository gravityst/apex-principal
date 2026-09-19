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
| `market.js` | The driver market: pay-offs, signing fees, buyouts, and the paddock's own moves between races. Reads nothing about the player's results when a rival changes driver. |
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

A resolved move is not a swap. It opens a `duel` on the attacker — a side, a closing rate and a duration of two to four seconds — and the extra speed is added to his `u` over that window, eased in with a sine so the pass happens while both cars are moving. A failed attempt gets the same treatment with the easing taken out and back, so he draws alongside and has to concede. The car being attacked sets `defending`, which moves *his* line the other way. Before this the engine wrote `c.distance = ahead.distance + 14` and the attacker teleported into the lead, which is exactly what it looked like.

`rollMistake()` also pushes onto `race.fx`, a queue of visual effects — locked wheels, gravel, a spin, the barrier, a pit release. The simulation does not know whether anything is drawing, so the queue is capped and a headless run simply ignores it.

## The 3D view

`src/race3d/carModel.js` is APEX F1's own `src/render/carModel.js`, unchanged apart from three rewritten import paths — bare specifiers (`three`, `three/addons/...`) became relative ones so the game needs no import map and no loader.

`src/race3d/scene.js` is new. APEX F1's track builder is 4,266 lines written against its own sampler, carrying scenery, weather and post-processing this game does not need, so the circuit is extruded here instead: asphalt, white lines, kerbs on the corners only, a run-off apron and a ground plane, all from `mgmt/track.js`'s centreline arrays.

Three details worth knowing:

- **Winding.** The extruded ribbons wind clockwise seen from above. Front-face culling hid the entire circuit while the cars floated over nothing — every track material is `DoubleSide`.
- **One camera, one dial.** `state.tilt` sweeps a single camera from a broadcast chase — low, behind, the road running to the horizon — to the tactical overhead you want when you are counting places. Pitch, look-ahead and the framing offset are all derived from it; the three buttons in the dock are presets, not separate cameras. The camera's turn rate scales with the time compression, or at 15× the circuit swings around underneath a view that cannot keep up.
- **Lens from aspect.** The *horizontal* field of view is held at 64° and the vertical one is derived from the pane. A split pane is nearly four times wider than it is tall; holding the vertical angle instead bends the world at the edges. The framing offset is a fraction of the lens rather than a fixed angle, or a long lens swings the car clean out of shot.
- **Split is side by side.** Stacked panes on a wide panel give each driver a strip no camera can frame. Half the width each gives both a shot you can read.
- **Interpolation, not chasing.** The simulation steps 0.25 s at a time — fourteen metres. Drawing those steps raw stutters; springing onto the newest one just turns the teleport into a lurch, because the error is a sawtooth the spring can never catch. `race.step()` records each car's `prevU` first, and the renderer draws at `lerp(prevU, u, alpha)` where `alpha` is how far the frame sits into the pending step. Frame-to-frame speed change went from a 162% 95th percentile to 0.02%. A jump over ~110 m (pit entry, recovery) resets `prevU` so the car is never interpolated sideways across the circuit.

Car state is synthesised, not simulated. A management game does not compute suspension travel, so wheel spin comes from speed, steer and body roll from local curvature, and compression from lateral load. Plausible beats absent.

`screenPositions()` projects each car into the active viewport so the DOM can hang a tag over it. In split view the same car appears in both panes, so the label pool is keyed by `id#pane` — keyed by id alone, the two panes fought over one element and one of them lost.

`world.js` builds what is around the circuit: a gradient sky dome, the rubbered-in racing line, hoardings and barriers both sides, gravel on the outside of the fast corners, stepped grandstands with roofs, instanced trees and the start gantry — plus `createPuffs()`, an instanced particle pool the race screen drives from `race.fx`.

## The race screen

`src/ui/racescreen.js`. The stage is the page: `body.racing` strips the main column's padding and width cap, and the screen measures what the chrome above it leaves and takes the rest.

Only what you act on is drawn over the 3D — the lap block, flags, one engineer call when it is urgent, a timing *window* (the leader plus the cars either side of each of yours, with a gap drawn where the order skips), and one deck per driver carrying his speed, energy, gaps, sectors and three buttons. Everything else — the full field, the strategy numbers, the radio — is behind three tabs in a sheet that is closed until you open it.

Two details that are not obvious:

- **The sheet takes what is left, not a fixed slice.** The decks are *overlaid* on the stage, so a sheet sized as a percentage of the window does not merely crop the 3D — past a point the decks are taller than what remains and they bury it. `sizeSheet()` reserves the decks' measured height plus a working 3D window and gives the sheet the remainder.
- **The tower is budgeted the same way.** It asks how many rows fit above the decks and narrows from ±2 cars to ±1 to ±0, and finally to just your two. A tower that runs off the bottom of the screen is worse than a short one.

Panels repaint five times a second, labels fourteen, the 3D every frame.

A car tag is a fixed number of *pixels* wide, so the spacing that keeps two of them apart is in pixels too. Expressed as a fraction of the viewport — which is what it was — they piled on top of each other as soon as the viewport got narrow.

### Held upright

A phone in portrait is the hard case, and it is handled by taking things away rather than shrinking them. During a race the top bar drops to the name and the way out; the timing tower goes; one deck shows at a time and the others swipe across; and the six camera buttons and three view buttons collapse to one button each that cycles. What is left is the 3D, one deck and eleven controls.

### Position is not progress

`raceengine.js` advances a car by `dt / lapTime`, which is a fraction of the lap's **time**. `phaseMap()` in `laptime.js` inverts the solved speed profile once and maps that onto a fraction of the lap's **length**, and everything the circuit's geometry owns goes through it: where the car is drawn, the DRS zones, the pit entry, the sector lines. Without it a car covers a hairpin at the same metres per second as the main straight, which is what made the cars look like they were on rails. One map serves the whole field — built per car, the profiles disagree by a tenth of a percent, and a tenth of a percent of a lap is six metres.

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
