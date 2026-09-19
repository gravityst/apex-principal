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

**On Sunday** — practice, a three-segment qualifying, and then a live race you watch in 3D. Four decisions per car: when to stop, what to fit, how hard to drive, and how to use the energy store. Time runs at 1×, 2×, 5× or 15×, or you can simulate the rest instantly.

## The race

The cars are the real APEX F1 models — the same procedural chassis, wings, halo, wheels and liveries the driving game renders, ported unchanged. The world around them is extruded from the same centreline the lap solver integrates, so what you watch is geometrically the thing being simulated: kerbs on the corners, gravel on the outside of the quick ones, barriers and hoardings, grandstands, trees, a start gantry and a rubbered-in racing line.

**The 3D is the screen.** It fills the window. Over it sit only the things you act on — the lap, the flags, your engineer when he has something urgent, a timing window showing the leader and the cars either side of each of yours, and one deck per driver with three buttons on it. The full field, the strategy numbers and the radio are behind three tabs that stay shut until you want them.

Three views, because they are three different jobs:

| | |
|---|---|
| **Chase** | low and behind, the road running away to the horizon — for a fight |
| **Broadcast** | the elevated tracking shot — for a stint |
| **Tactical** | overhead — for counting places |

Zoom on a scroll wheel or a pinch. Follow either driver, follow the leader, or pick **Both** and run a split screen — side by side, one camera each. Every car carries a tag: position, driver code, compound and tyre age, so the view is something you read rather than just something you look at.

The simulation advances in quarter-second steps, but the renderer interpolates *between* them, so the cars move at constant velocity on screen rather than teleporting fourteen metres at a time. Measured over 1,500 frames, the frame-to-frame change in a car's speed has a median of 0.00% and a 99th percentile of 0.05%.

Overtakes happen the same way. A move is a manoeuvre with a side, a closing rate and two to four seconds to complete it, so the cars go wheel to wheel and the place changes while both are moving. When it does not come off, he draws alongside and has to concede. And when somebody locks a wheel, runs through the gravel or spins it, you see the smoke.

## Two cars, one of you

Hand-flying both cars is too much, so each one has an **Engineer / You** switch on its deck:

- **Engineer** — his own race engineer runs the strategy: stops, compounds, pace, fuel saving. He announces every call on the radio before he makes it, so you can disagree in time.
- **You** — nothing happens to that car unless you say so.

Either way every button stays live. Press one on an engineer-run car and your call is executed immediately and stands for three laps before he takes it back. By default your better-placed car is yours and the other runs itself.

Each deck has three buttons — **BOX**, **PUSH**, **DEPLOY** — sized to be hit without looking. BOX calls him in on the compound his engineer would fit; the chevron beside it opens the rest, and with it the full pace and energy options.

## What the deck shows

Per car, live: **speed** in km/h taken from the solved speed profile at the car's actual point on the circuit, **ERS charge** (deploying drains it, harvesting rebuilds it, and running it flat forces you back to balanced), **DRS**, the gap ahead and behind with driver codes, last and best lap, and all three **sector times** — live for the sector in progress, coloured against that driver's own best.

## Knowing when to push

This is the part a management game usually asks you to guess at. Here the pit wall runs the numbers, live, from the same lap model the race uses:

| | |
|---|---|
| **Deg** | what one more lap of wear costs you, in seconds |
| **Tyre cost** | what this set is already giving away against a fresh one |
| **Stop costs** | pit transit plus stationary time, minus racing that stretch |
| **Rejoin** | the position you would come out in, and who you would come out behind |
| **Undercut** | the swing a fresh tyre gives you against the gap you have to cover — ON, MARGINAL or OFF |
| **Fuel** | laps of fuel spare, or short |
| **Push / Save** | seconds a lap gained or saved, and the laps of tyre life it costs or buys |
| **Risk** | how likely your driver is to make a mistake, per lap, if you send him |

Above them sits one sentence saying what it all implies — *"Undercut is on: 2.4s of swing against a 1.1s gap. Box this lap and you come out ahead of Vasseur."* — and your race engineer says the same thing over the radio before it is too late to act on.

## Team radio

Four voices, each one styled and labelled so you can tell them apart at a glance:

- **ENGINEER** — your own pit wall: pit windows, undercuts, fuel, the car behind that has just stopped on fresh rubber
- **DRIVER** — yours, in his own words, including the times he tells you no
- **RACE CONTROL** — flags, safety cars, penalties
- **BROADCAST** — everything happening to everyone else

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
node tools/fxcheck.mjs          # how often the race asks the view for smoke
```

`tools/probe.mjs` is the one worth looking at first — it prints what each development department is worth at each circuit, which is the whole design in one table.

## Saves

The game saves to browser storage automatically, and every save can be exported to a JSON file from the menu. Saves are seeded: the same save replayed gives the same races, which is why you cannot reload to dodge a safety car.

## A note on names

Every team, driver, sponsor, engine and circuit in this game is invented, inherited from APEX F1. Any resemblance to a real racing organisation is coincidental.

## Licence

MIT.
