# APEX: Principal

A Formula-style **team management** simulator that runs entirely in the browser. No install, no plugins, no build step — open the file and take the job.

You never drive. You build the car, hire the people, spend the money, and on Sunday you call the race from the pit wall — and then watch two grown adults decide whether to listen to you.

Built on the physics of [APEX F1](https://github.com/gravityst/apex-f1), which this is a fork of.

---

## Play it

Open `index.html`. That is the whole install.

To put it on the web, it deploys to **GitHub Pages** as-is — the repository *is*
the site, because there is no build step:

```bash
# once, from the project folder
gh repo create apex-principal --public --source=. --remote=origin --push
gh api -X POST repos/:owner/apex-principal/pages -f build_type=workflow
```

or, without the `gh` CLI: create an empty public repo on github.com, then

```bash
git remote add origin https://github.com/<you>/apex-principal.git
git push -u origin master
```

and in **Settings → Pages**, set *Source* to **GitHub Actions**. The workflow in
`.github/workflows/pages.yml` publishes every push. The site lands at
`https://<you>.github.io/apex-principal/`.

### On a phone

Open that URL, then **Share → Add to Home Screen**. It installs as a real app:
its own icon, no browser chrome, portrait-locked, and — because `sw.js` caches
the whole shell on first run — it opens with no signal at all.

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

**Change your mind about a driver** — at any point in the season, not just over the winter. Ending a contract early costs what is left of it; getting the next man in costs a fee, or a buyout if he is already in somebody's car. Their team will replace him and will not thank you. Rival teams do the same thing to each other, and the paddock talks about all of it in the news.

**On Sunday** — practice, a three-segment qualifying, and then a live race you watch in 3D. A grand prix is a grand prix: about 305 kilometres, which is 55 to 68 laps depending on the circuit and around ninety minutes of race time. If that is more than you want on a weeknight, the menu will run it at three quarters or half distance — a shorter race, not a faster one, and the strategy changes with it. Four decisions per car: when to stop, what to fit, how hard to drive, and how to use the energy store. Time runs at 1×, 2×, 5× or 15×, or you can simulate the rest instantly.

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

### An overtake is a fight, not a swap

Nothing about it is scripted. When a car gets within a second, the engine finds
the next braking zone and works out how long the run to it is. The attacker sits
in the tow — where he loses downforce in the corners and gains a slipstream on
the straights — and only pulls out for the braking zone, because moving across
early throws away the one thing that was going to get him there. What he closes
in that time is whatever his advantage is actually worth: pace, tyre, tow, the
DRS flap, minus how well the man in front defends.

The overlap that produces at turn-in is what decides the corner. Down the inside
a front wheel alongside is enough; round the outside it is not, and if he has
not got there he has to lift. The defender is not a bystander — he covers the
inside when he sees it coming, which is why the attacker often ends up on the
long way round. A move that does not stick can cross back and go again on the
exit. Two cars alongside at the apex sometimes touch.

And they cannot drive through each other. How close one car may get to another
is a function of how far across the road it is: fully alongside, a couple of
metres; on the same line, a car's length and a bit; and everything in between
graded, because half a car's width of overlap is exactly where two cars end up
occupying the same piece of road.

### Air

Following someone costs you downforce, which costs you the corners — measured
through the same grip sensitivity the lap solver already computes, so a slow,
twisty circuit punishes it far more than a fast one. The tow gives some of it
back on the straights and never all of it. Net, following is a loss, which is
why a train forms behind a car nobody can pass and why DRS exists at all.

Drivers behave accordingly. A rival stuck in someone's wake with no way past
will drop back out of it, cool the car and come again with a run. A rival with
somebody in his mirrors puts his head down and tries to break the tow before it
matters.

### DRS

There is a detection point before every zone. You are only given the flap if you
were inside a second at that line, which is why a clever defender will sometimes
back off to lose the detection. When it opens, the rear wing opens with it.

An overtake is aimed at a corner. When a move starts, the engine finds the next braking zone, works out how long it takes to get there, and spends the whole distance along a curve that is slow out of the corner behind, quick on the brakes and settled by the exit. The man in front moves across to cover and eases back as it resolves. Sometimes they touch. Sometimes he gets it back on the exit, which is the best thing in racing.

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

It is on the track, not behind a tab: the newest four messages sit over the
circuit on the left, newest on top, each with the lap and the time it was said,
and none of it takes a click or covers a control. The full log is one tap away.

Two of the four voices are yours and they do not sound alike. The **engineer**
has the numbers — gaps, intervals, tyre life, what the car behind is on — and he
volunteers them: the tyre going through sixty and then eighty percent, a rival
two seconds back on fresher rubber and what to do about it, the overcut if the
man in front has not stopped, the last lap. The **driver** has the car, and he
is short with you: *"He shut the door. I had to lift."* — *"Copy. Leave me to
it."*

Everything either of them says is triggered by something that actually happened
in the simulation. When the overtake system commits a car to the inside, the
radio says so as it happens; when the move fails, it says that too.

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

## What the race costs to draw

Twenty cars at full detail is about six hundred draw calls a frame and no phone will hold that, so detail is spent where it can be seen. Cars near the camera get the real model; the ones down the road get the cheap one; a quarter of a mile away they are not drawn at all, and on a small machine only the cars actually in the fight are drawn while the timing tower speaks for the rest. Four cars cast a real shadow and every car gets an instanced contact shadow, which is one draw call for all twenty. If the frame still slips, the renderer takes something away — shadows first, then resolution — and puts it back when it can. Draw calls came down from 270–470 to 70–190.

## Getting the small things right

A virtual safety car is a delta-time procedure to clear something small, and it
is over in well under a lap — so it is counted in seconds, not laps, and lasts
between half a minute and a minute and a bit. A full safety car is counted in
laps, because that is how race control counts it: a lap to gather the field, a
lap or two while the marshals work, then "safety car in this lap". Three,
usually. Under either, the field is about forty percent off the pace rather than
sixty. Track limits get a black-and-white flag on the third warning and five
seconds on the fourth.

## On a phone

Held upright. The 3D takes the screen, the chrome above it shrinks to the name and the way out, the timing tower steps aside, one driver's deck at a time swipes across, and the camera and view controls collapse to a button each that cycles. Pinch to zoom.

## Making it yours

A **Customise** tab, for your team and for the other nine. Team name, three
letter code and colours; each driver's name, code and number; a badge; and a
livery you upload — a square image wrapped down the flank of the car and
mirrored across it, which is exactly what a Monoposto template is. It all goes
into the save, so it survives a reload and travels with an export.

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
