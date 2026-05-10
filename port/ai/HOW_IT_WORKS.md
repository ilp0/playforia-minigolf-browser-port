# How the minigolf RL trainer works

A plain-English guide to everything in `port/ai/`. No prior knowledge of
machine learning required.

---

## 1. What is this?

It's a small browser app that **teaches a tiny neural network to play
Aapeli minigolf maps**. You watch a ball get whacked across a course
thousands of times — bad shots at first, gradually better — until the
network has figured out a reliable way to sink the ball in as few strokes
as possible.

Two ways to use it:

- **Single-map view** (`/`): pick one map, watch four agents train on it
  in parallel, with charts and stats.
- **Grid view** (`/grid.html`): train any number of maps side by side.
  Use it to "solve every map in the catalogue" overnight.

Everything runs in the browser. Nothing gets sent to a server. Trained
policies are saved in your browser's localStorage so they survive
refreshes.

---

## 2. The big idea (how the agent learns)

Imagine teaching a kid minigolf without telling them any rules. You let
them swing the club, see where the ball goes, and just say "good" if it
got closer to the hole or "bad" if it got farther. After thousands of
swings, the kid will have figured out — through pure trial and error —
how to play that hole.

That's exactly what's happening here, just much faster. The "kid" is a
neural network. Each "swing" is one stroke. The "good/bad" signal is the
**reward**.

The big difference from a real kid: the network has no eyes. It doesn't
*see* the map as pixels. Instead, it gets a small list of numbers
describing the ball's situation, and it outputs two numbers describing
where to aim. That's it.

---

## 3. What the agent actually sees and does

### State (input to the network) — 79 numbers

- 4 numbers describing position: ball x, ball y, hole x, hole y
  (normalized to roughly -1 to 1).
- 75 numbers describing a **5×5 grid of tiles around the ball**, with 3
  flags per tile: "is this a wall?", "is this the hole?", "is this a
  hazard (water, mine, acid)?".

The grid lets the network see its immediate surroundings — without it,
the network would have to memorize positions from scratch on each map.

### Action (output of the network) — 4 numbers

- 2 numbers for the *mean* of the shot: how far in x and y to aim from
  the ball.
- 2 numbers for the *uncertainty* of the shot: how much random spread
  to add around the mean.

The actual shot is a random sample from a 2D Gaussian "blob" centered on
the mean. If the network is uncertain, the blob is wide and shots vary
a lot. If it's confident, the blob is tight and shots cluster.

### The shot itself

The two action numbers are interpreted as a mouse-cursor offset from the
ball. Distance from ball = power. Direction = aim. This is exactly how
the original Aapeli minigolf game worked — you click the mouse somewhere
near the ball and the ball flies in that direction with that much force.

---

## 4. The network's brain

It's a small "multi-layer perceptron" (MLP). Three layers of math:

1. **79 inputs → 32 hidden neurons** (with a "tanh" squash that keeps
   numbers between -1 and +1)
2. **32 hidden → 4 policy outputs** (the means + uncertainties above)
3. **32 hidden → 1 value output** (the *critic*; explained below)

That's about 2,700 numbers ("weights") that get tuned during training.
A serious modern AI has billions of weights — this is tiny. The whole
network fits comfortably in 100 KB of localStorage.

### The actor and the critic

There are *two* heads on the network sharing the same first layer:

- The **actor** (policy head, 4 outputs) decides what action to take.
- The **critic** (value head, 1 output) predicts how well the agent is
  going to do from this state.

This is called **actor-critic**. The critic helps the actor learn more
stably — instead of judging an action only by the final outcome, the
actor compares the outcome to what the critic *predicted* the outcome
would be. Surprises (good or bad) are what drives learning.

---

## 5. The training loop

For one map, the loop looks like this:

1. Start a fresh ball at the map's start tile.
2. **Look** at the state (79 numbers).
3. **Forward pass:** run the state through the network → get the action
   distribution.
4. **Sample** a random action from that distribution.
5. **Apply** the shot. Physics runs the ball until it stops or holes.
6. If holed → episode done. If not, go to step 2 for the next stroke.
7. After 30 strokes without holing → episode is a "failure".
8. Compute the **reward** for the episode.
9. **Backward pass:** adjust the network's weights so good actions
   become more likely and bad actions less likely next time.
10. Start a new episode and repeat.

Steps 1–7 are "rollout". Step 9 is "learning". The whole thing runs
hundreds of times per second on a normal computer.

### The reward

Simple recipe:

- **−1 for every stroke** (so the network is encouraged to use fewer
  strokes).
- **+20 if you eventually hole it**, 0 if you fail.

Examples:
- Holed in 1 stroke → reward = −1 + 20 = **+19** (great)
- Holed in 5 strokes → reward = −5 + 20 = **+15** (good)
- Failed at 30 strokes → reward = −30 (bad)

### What "adjust the weights" means

For each stroke the agent took, the math computes a tiny nudge to every
single weight in the network — saying "this weight should go up a bit"
or "this weight should go down a bit" — based on whether the episode
turned out better or worse than the critic predicted. After running
many episodes, all those tiny nudges add up to a network that aims
better.

This is called **REINFORCE with a value baseline**. It's the same family
of algorithms used in modern RL papers like PPO and A2C, just stripped
of refinements.

### Multi-environment rollouts

Instead of running one episode at a time, the single-map view runs
**4 episodes in parallel**, all sharing the same network. The four white,
red, blue, and yellow balls you see on the canvas are the four parallel
agents. Their gradients get averaged before the weights actually change,
which makes learning more stable than any single episode would be.

---

## 6. Modes (single-map view)

A dropdown in the side panel switches between three modes. Switching is
non-destructive — weights and stats stay put, only what the agent
*does* changes.

- **training** — random shots from the policy distribution; weights
  update after each episode. This is how the agent gets better.
- **eval** — no randomness; the agent uses the network's mean shot
  every time. Weights are frozen. Use to see what the policy thinks the
  "average best" shot is.
- **best** — replays the exact stroke sequence from the *best-ever*
  episode you've recorded on this map. This is often shorter than the
  eval line because best-ever runs are the lucky tail of the random
  distribution — strokes that the noisy training found by chance.

When the agent reaches PERFECTED (hole-in-1) it auto-switches to "best"
mode. The recorded sequence becomes the demo.

---

## 7. Status badges (what "solved" means)

The little colored pill on each map tells you roughly how done the
agent is:

| Badge | When you see it | What it means |
|---|---|---|
| **TRAINING** (gray) | Early, success rate < 50% over recent episodes | The agent is still figuring it out. |
| **CONVERGING** (amber) | Success rate ≥ 50% | Holes more often than not. Getting there. |
| **CONVERGED** (green) | Success ≥ 90% over the last 50 episodes, plus 30+ lifetime | Reliably solves the map. Auto-saved. |
| **PERFECTED** (bright green) | Hole-in-1 achieved in eval mode | The optimal possible. Training auto-stops. |
| **LOADED** (blue) | Loaded a CONVERGED save without enough fresh runs to confirm | "We trust the save but haven't seen 50 fresh runs yet." |

The "fully solved for our purposes" line is **CONVERGED**. PERFECTED is
a bonus — only some maps allow hole-in-1.

---

## 8. The chart

A small line plot below the canvas shows the per-episode reward over
time:

- **Bright dots** = one episode each
- **Bold green line** = rolling mean over the last 25 episodes

A successful learning run looks like a line that starts low (around −25
for failures) and climbs toward positive territory as the agent figures
out the map.

---

## 9. The speed knob

A slider lets you change how many physics ticks happen per rendered
frame. The browser draws ~60 frames per second; the slider just
multiplies how much *simulated time* passes between each frame.

- **3** = real game speed (matches the original Aapeli pacing)
- **30** = ~10× faster, still smooth animation
- **500–5000** = balls become streaks, fps drops as the per-frame work
  gets heavy

For a video recording, anywhere between 30 and 200 looks good. For
"train as fast as my CPU can go", crank it to 5000.

The slider only affects training cells. Cells in eval/best demo mode
play at real game speed regardless — that's the deterministic playback,
no point fast-forwarding.

---

## 10. Persistence (saving across reloads)

Trained networks save themselves to your browser's **localStorage**.
One key per map, like `minigolf-ai:policy:v1:CurveI.track`. Each save
is about 100 KB and contains:

- All 2,700+ network weights
- The current best-strokes record
- The recorded best-ever action sequence
- Status (BEST_IMPROVED / CONVERGED / PERFECTED)
- Lifetime episode count
- Recent rolling-window stats (so charts and counters resume in place)

Saves happen automatically when:
- A new best-strokes record is hit
- Status crosses into CONVERGED
- Status reaches PERFECTED
- Every 50 episodes (so live counters stay current)

On load, if a save exists for the picked map, it gets restored
automatically. PERFECTED saves auto-enter "best" mode and start their
demo loop right away.

**Where to find it on disk**: F12 → Application tab → Local Storage →
`http://localhost:5180`. Each entry is a JSON blob. The "delete saved
policies" button in the grid view's header wipes everything.

---

## 11. The grid view

`/grid.html` shows N cells, one per map, all training simultaneously.

What's nice about it:

- **Add any map** from the 2,000+ available via the dropdown at the
  top.
- **Remove any cell** with the × button on its header.
- **Selection persists** in localStorage, so your custom set comes back
  on refresh.
- **Each cell shows the original Playforia metadata**: map author, par
  (best human score), record holder, total plays, etc. Compare the
  agent's `best:` to the human `par:` to see how it's doing.
- **Solved cells stop training** and play their best route at game
  speed on a loop. Great for video — once a map flips to green, it
  becomes a clean visual on permanent loop.

Memory cost is roughly 10 MB per cell. With 6 cells (default) you're
using ~60 MB. Don't add 200 cells unless you've got memory to spare.

---

## 12. Common things to do

### Train one map fast
1. Open `/`
2. Pick a map
3. Slide speed up to ~500
4. Wait a few minutes for the badge to turn green

### Solve every curated map
1. Open `/grid.html`
2. Slide speed up to 1000+
3. Walk away
4. Come back, look at the `solved: X / Y` counter

### Make a video of clean playback
1. Open `/grid.html`
2. Add the maps you want
3. Wait until they all turn green
4. Record the screen. Each cell is now a deterministic loop at real
   game speed.

### Compare your policy to humans
- Look at the metadata under each map. `avg strokes / play` is the
  human community's average. The agent's `best` and `success` should
  match or beat this on easy maps.

### Reset everything
- "delete saved policies" in the grid header wipes all saves.
- "reset agent" in the single-map side panel resets just the current
  map's network.

---

## 13. Files (where stuff lives)

```
port/ai/
├── index.html        single-map view
├── grid.html         grid view
├── HOW_IT_WORKS.md   you are here
├── public/           (none — assets come from ../web/public)
└── src/
    ├── main.ts       entry point for /
    ├── grid.ts       entry point for /grid.html
    ├── nn.ts         tiny MLP class (forward pass + Xavier init)
    ├── agent.ts      MLPAgent (actor-critic, REINFORCE backprop)
    ├── env.ts        Episode class (wraps physics into a rollout)
    ├── render.ts     canvas drawing (via the production TrackRenderer)
    ├── chart.ts      reward sparkline
    ├── loader.ts     loads .track files into ParsedMap + atlases
    ├── tracks.ts     enumerates all .track files via Vite glob
    ├── storage.ts    localStorage helpers (save/load policies)
    └── track-data.ts (legacy, unused)
```

The agent imports physics directly from the main web client at
`../web/src/game/physics.ts` and `../web/src/game/map.ts`. It uses the
exact same simulator the live game uses, so anything the agent learns
to do, a real player could in principle do too.

---

## 14. Things that can go wrong (and what they look like)

### "It's stuck at TRAINING forever"
The map is too hard for the simple feature set. Try a different map, or
let it train for thousands more episodes. Some Aapeli maps require
trick shots that the 5×5 tile grid can't see far enough to plan.

### "PERFECTED but success shows 0%"
Old save format from before the perfection criteria were tightened. The
saved policy was crowned PERFECTED based on a noise-lucky shot that
doesn't reproduce deterministically. Click "delete saved policies" and
let it retrain.

### "The chart is mostly negative"
Normal during early training. Untrained networks score around −30 (the
"max strokes, no hole" baseline). Wait — it'll climb.

### "Browser feels sluggish"
You're at slider 5000+ which pegs one CPU core. JavaScript is
single-threaded so there's no way to use more without Web Workers
(not implemented). Drop the slider down or close the tab.

### "I want to track 200 maps"
The grid view grows linearly in memory. 200 cells = 2 GB. If you really
need this scale, the right approach is a Web Worker per cell — same
agent code, just running in parallel threads. Not built; would be a few
hundred lines of work.

---

## 15. Glossary

- **Agent** — the thing playing the game. Here, a small neural network.
- **Episode** — one full attempt: from start to either holing the ball
  or running out of strokes (max 30).
- **Policy** — the agent's strategy. In our case, the network that maps
  state → action distribution.
- **Reward** — the signal the agent uses to learn. Positive when good
  things happen, negative when bad things happen.
- **Rollout** — running the policy through one or more episodes to
  collect data.
- **Trace** — the recorded sequence of (state, action, value) for one
  episode. Used by the learning step.
- **Backprop** — the math that figures out how to nudge each weight to
  make good actions more likely. Short for "backpropagation".
- **Xavier init** — a recipe for initial random weights that keeps the
  signal flowing through layers without exploding or vanishing.
- **σ (sigma)** — the standard deviation of the action distribution.
  Big σ = lots of exploration, small σ = the policy is committed.
- **γ (gamma)** — the "discount factor". 0.99 means the agent slightly
  prefers near-future rewards to far-future ones. We use 0.99.
- **REINFORCE** — the classic policy-gradient algorithm. The grandparent
  of PPO, A2C, and friends.

---

That's the whole thing. The codebase is around 2,000 lines of TypeScript
+ 300 lines of HTML and CSS. Read `agent.ts` if you want to see the
actual learning math — it's heavily commented and avoids any deep-learning
library, so every gradient is visible.
