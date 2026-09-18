# APEX: Principal

A Formula-style **team management** simulator that runs entirely in the browser. No install, no plugins, no build step — open the file and take the job.

You never drive. You build the car, hire the people, spend the money, and on Sunday you call the race from the pit wall — and then watch two grown adults decide whether to listen to you.

Built on the physics of [APEX F1](https://github.com/gravityst/apex-f1), which this is a fork of.

---

## The idea

Most management games hide a single "car performance" number behind a row of stat bars. This one does not have that number.

Eight development departments each map onto a **real physical parameter**. When the aero department delivers, the car's downforce coefficient `CL·A` goes up. A quasi-steady-state lap solver then integrates that car around the actual centreline geometry of the circuit, corner by corner, respecting a friction ellipse — and the lap time falls out of the physics.

The consequence is that circuits have genuine character, and nobody wrote it into a table:

| Circuit | Character | What it pays for |
|---|---|---|
| Neon Harbour | Street circuit, 49% of the lap turning | Mechanical grip, downforce |
| Monsoon Valley | Long, flowing, wet | Downforce above everything |
| Crimson Flats | Desert autodrome, 24% turning | Aero *efficiency* — more wing actively costs you time |
| Aurora Bay | Fast, cliff-top | A complete car |
| Summit Ridge | Elevation change | Power and efficiency |

The factory screen shows you exactly what each department is worth, in seconds a lap, at the circuits you have left to race. That is computed live from the solver, not looked up.

## What you actually do

**Between races** — allocate a development budget across eight departments, each with its own cost curve and its own uncertainty. You buy an *expected* gain; the wind tunnel tells you what you actually got. Sometimes it is a breakthrough. Sometimes the parts go in the bin.

**Sign the commercial deals** — a title sponsor, majors and minors, each with performance clauses that pay out at the end of the season.

**Run the factory** — seven facilities, five levels each. A better wind tunnel does not make the car faster; it makes development faster and duds rarer.

**Hire** — a technical director lifts every department a little. A chief aerodynamicist lifts two of them a lot. And your two drivers each have skill, consistency, aggression, wet-weather ability, a temperament and a morale.

**On Sunday** — practice, a three-segment qualifying, and then a live race with a track map, a timing tower and a radio feed. Four decisions per car: when to stop, what to fit, how hard to drive, and how to use the energy store. Time runs at 1×, 2×, 5× or 15×, or you can simulate the rest instantly.

## The drivers are people

They are not control inputs. Depending on temperament, morale, how the race is going and who they are racing, a driver may simply refuse:

> **Andre Bassi:** "Negative, I'm not lifting. I've got a run on him."

> **Jonas Reiter:** "I'm faster than him. Let me race."

And having refused, he stops listening for a while — which is its own problem, because a driver running on emotion makes more mistakes. Over a race they lock up, run wide, spin, and occasionally put it in the wall. How often depends on consistency, how hard you are asking them to push, how worn the tyres are, how wet it is, and whether somebody is climbing all over the back of them.

## The rivals do not cheat

There is a rule in `src/mgmt/rivals.js`: **nothing in that file reads the player's results, the player's car, or the player's championship position.** Rivals develop against their own budgets and their own convictions. If you have a season off, they get further away. If you build the fastest car on the grid, they do not mysteriously find half a second to match it.

What keeps a championship close over the years is not rubber-banding. It is the same three things that keep a real one close:

- development gets sharply more expensive the further you push it;
- a budget cap stops money solving everything;
- the regulations periodically throw part of the work away.

Measured over 24 simulated races, grid position predicts finishing position with r ≈ 0.82, pole converts to a win about half the time, and there are roughly 2 retirements and 0.4 accidents a race — numbers that sit where a real championship sits.

## Running it

Any static server. There is no build step and no dependency.

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Or push the folder to GitHub Pages, as APEX F1 does.

## Tools

The simulation is pure and dependency-free, so it runs headless under node:

```sh
node tools/probe.mjs            # lap solver against each circuit's lap record
node tools/simrace.mjs 0 7      # one race weekend, fully simulated
node tools/simseason.mjs 6 42   # six seasons, for balance
```

`tools/probe.mjs` is the one worth looking at first — it prints what each development department is worth at each circuit, which is the whole design in one table.

## Saves

The game saves to browser storage automatically, and every save can be exported to a JSON file from the menu. Saves are seeded: the same save replayed gives the same races, which is why you cannot reload to dodge a safety car.

## A note on names

Every team, driver, sponsor, engine and circuit in this game is invented, inherited from APEX F1. Any resemblance to a real racing organisation is coincidental.

## Licence

MIT.
