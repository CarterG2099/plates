# Exercise videos — every animate command

Short looping clips of the exercise drawings, one per exercise, so the movement
can be seen rather than inferred from a single frame. Made by hand in the Gemini
app, whose video model can animate an uploaded image. **Covers the 46 exercises
in the current routines** — the other 144 drawings can follow the same way.

The drawings are the starting frames. That is what makes this cheap: the style
work is already done in `exercise-prompts.md`, so nothing below describes the
figure, the colours or the background. Each command only says **how the figure
moves**, and orders the model to change nothing else.

Filenames are the drawing's slug with `.mp4` — `bench-press-barbell.mp4` — so a
clip and its drawing can never disagree about which exercise they are.

**The app does not show videos yet.** This file is the generation recipe only;
wiring clips into the exercise sheet is its own change. Until then, put the
clips in `docs/img/exercises/v/` so they have a home.

---

## How a clip is made

1. In the Gemini app, start a video generation and **upload the drawing** from
   `docs/img/exercises/<slug>.png` as the image to animate.
2. Paste the exercise's command below as the prompt.
3. Save the result as `<slug>.mp4`.

Each command is self-contained: video generations do not carry the style
forward the way the image conversation did, so the "change nothing" clause is
repeated in every one rather than pasted once.

**Check the first clip before making forty more.** Things to look at:

- **Aspect ratio.** The drawings are square; video output is usually landscape.
  See whether the drawing is letterboxed, cropped, or extended with new black
  space. Extended black is fine — it is the same background. Cropped is not.
- **Sound.** The commands ask for silence. If the model adds audio anyway, the
  clip can be muted when it is shown, so this is not worth fighting.
- **Nothing extra.** A second figure, a face, a gym in the background, or the
  equipment redrawn are all failures. The clause in every command exists because
  video models love to add these.
- **The right exercise.** Same rule as the drawings: check that what came back
  is what was asked for. A pushdown that becomes a curl is a plausible failure.

If a clip comes back wrong, regenerate with the same image and add one sentence
to the command naming the fault — "the bar must touch the chest", "the other leg
does not move" — rather than rewriting the whole thing.

---

## Two drawings to fix first

The slicer left debris in two of these, and a video model will animate whatever
it is given:

- `stair-machine-steps.png` has part of a neighbouring figure and bench at the
  right edge.
- `back-extension.png` has a stray weight plate at the left edge.

Re-slice both (`node tools/art.mjs region ...`) before making their clips, or
the fragments will move.

---

## The commands

Grouped by routine, in routine order. An exercise that appears in more than one
routine is listed once, under the first, and pointed to after that.

### Chest/Shoulders 1.0

**Bench Press (Barbell)** — upload `bench-press-barbell.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a barbell bench press: lower the bar under control until it touches the middle of the chest, pause for a beat, then press it straight up until the arms lock out; feet flat, hips on the bench. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Incline Bench Press (Dumbbell)** — upload `incline-bench-press-dumbbell.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of an incline dumbbell press: press both dumbbells up and slightly together above the upper chest until the arms are straight, then lower them until the elbows drop just below shoulder level. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Rear Delt Reverse Fly (Machine)** — upload `rear-delt-reverse-fly-machine.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a machine reverse fly: with the chest against the pad, sweep both handles out and back in a wide arc until the arms are in line with the shoulders, pause, then let them return forward slowly; only the arms and the machine arms move. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Chest Fly (Machine)** — upload `chest-fly-machine.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a machine chest fly: bring both arms together in a wide arc until the handles nearly touch in front of the chest, squeeze, then open back until the upper arms are level with the shoulders. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Shoulder Press (Machine Plates)** — upload `shoulder-press-machine-plates.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a machine shoulder press: press both handles straight up until the arms lock out overhead, then lower them until the hands are level with the ears; the weight plates on the machine arms rise and fall with the hands. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Seated Lateral Raise** — upload `seated-lateral-raise.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a seated lateral raise: raise both dumbbells out to the sides with a slight bend in the elbows until they reach shoulder height, pause, then lower them back beside the thighs; the torso stays upright on the bench. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

### Chest/Shoulders 2.0

**Incline Bench Press (Barbell)** — upload `incline-bench-press-barbell.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of an incline barbell press: lower the bar until it touches the upper chest just below the collarbone, pause, then press it straight up until the arms lock out. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Iso-Lateral Chest Press (Machine)** — upload `iso-lateral-chest-press-machine.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a plate-loaded chest press: push both handles forward until the arms are straight, then let them return until the hands are beside the chest; the plates on the machine's arms swing forward and back with the press. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Chest Fly (Machine)** — see Chest/Shoulders 1.0.

**Shoulder Press (Machine Plates)** — see Chest/Shoulders 1.0.

**Lateral Raise** — upload `lateral-raise.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a standing lateral raise: raise both dumbbells out to the sides with a slight bend in the elbows until they reach shoulder height, pause, then lower them back beside the thighs; the body stays still and upright. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Rear Delt Reverse Fly (Machine)** — see Chest/Shoulders 1.0.

### Back 1.0

**Pull-Up** — upload `pull-up.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a pull-up: from a dead hang, pull up until the chin clears the bar, pause, then lower under control until the arms are straight; the legs hang still. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Bent Over Row (Barbell)** — upload `bent-over-row-barbell.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a barbell bent over row: with the torso held still in its forward lean, pull the bar up to the lower ribs with the elbows driving back, pause, then lower it until the arms hang straight. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Lat Pulldown** — upload `lat-pulldown.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a lat pulldown: pull the wide bar down to the top of the chest with the elbows driving down and back, pause, then let it rise back overhead until the arms are straight; the weight stack rises and falls with it. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Seated Cable Row - V Grip (Cable)** — upload `seated-cable-row-v-grip-cable.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a seated cable row: pull the V handle in to the stomach with the elbows close to the ribs and the shoulder blades squeezing together, then extend the arms forward until they are straight; the torso stays upright and the weight stack rises and falls. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Single Arm Lat Pulldown** — upload `single-arm-lat-pulldown.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a single arm lat pulldown: pull the handle down with one arm until the hand is beside the shoulder, the elbow driving toward the hip, then let it rise back until the arm is straight; the other hand stays resting on the thigh. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Back Extension** — upload `back-extension.png` (re-slice first, see above)

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a back extension on the angled bench: hinge at the hips to lower the torso toward the floor, then raise it back up until the body forms one straight line from head to heels, never arching past straight; the legs and feet stay fixed on the pads. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

### Back 2.0

**Iso-Lateral Row (Machine)** — upload `iso-lateral-row-machine.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a plate-loaded machine row: pull both handles back toward the ribs with the elbows tracking close to the body and the shoulder blades squeezing together, then let the arms extend forward until straight; the plates on the machine arms move with the pull. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Lat Pulldown** — see Back 1.0.

**Seated Row - Bar Wide Grip (Cable)** — upload `seated-row-bar-wide-grip-cable.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a wide grip seated cable row: pull the long bar in to the lower chest with the elbows flaring wide, then extend the arms forward until they are straight; the torso stays upright and the weight stack rises and falls. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Straight Arm Lat Pulldown (Cable)** — upload `straight-arm-lat-pulldown-cable.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a straight arm pulldown: with both arms locked straight, sweep the bar down in an arc from overhead to the thighs, pause, then let it rise back overhead along the same arc; the elbows never bend. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Shrug** — upload `shrug.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a barbell shrug: lift both shoulders straight up toward the ears as high as they go, pause, then lower them fully; the arms stay straight and the bar only moves up and down. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Reverse Curl (EZ Bar)** — upload `reverse-curl-ez-bar.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a reverse curl: with the palms facing down, curl the bar up to the shoulders with the elbows pinned at the sides, then lower it until the arms are straight. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Cycling** — upload `cycling.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure with no red anywhere, the bike stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure pedals at an easy, steady cadence for the whole clip: the legs turn in a smooth continuous circle, the pedals and wheels turn with them, and the upper body stays relaxed and still. Finish with the pedals where the image starts, so the clip loops.

### Legs 1.0

**Squat (Barbell)** — upload `squat-barbell.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a barbell back squat: stand up out of the squat until the hips and knees are fully straight, then sit back down until the thighs are below parallel; the bar stays on the upper back, the chest stays up and the feet stay planted. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Romanian Deadlift** — upload `romanian-deadlift.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a Romanian deadlift: push the hips back and lower the bar down the front of the thighs to just below the knees with only a slight bend in the knees, then drive the hips forward to stand tall; the back stays flat and the arms stay straight. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Leg Extension** — upload `leg-extension.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a leg extension: straighten both legs until they are fully extended out in front, pause, then lower the ankle pad back down until the knees are bent to ninety degrees; the torso stays against the back pad. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Single Leg Standing Calf Raise (Dumbbell)** — upload `single-leg-standing-calf-raise-dumbbell.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a single leg calf raise: rise up onto the ball of the standing foot as high as possible, pause, then lower the heel below the edge of the step; the other leg stays lifted behind and the dumbbell hangs still. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

### Legs 2.0

**Leg Press** — upload `leg-press.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a leg press: push the sled up until the legs are nearly straight, then lower it until the knees are bent to ninety degrees; the back and hips stay on the seat. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Standing Calf Raise** — upload `standing-calf-raise.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a standing calf raise: rise up onto the balls of both feet as high as possible, pause, then lower the heels below the edge of the platform; the shoulders stay under the pads and the weight stack rises and falls. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Leg Extension** — see Legs 1.0.

### Arms/Abs 1.0

**Curl (Cable)** — upload `curl-cable.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a cable curl: curl the bar up to the shoulders with the elbows pinned to the sides, pause, then lower it until the arms are straight; the cable stays taut and the weight stack rises and falls. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Triceps Pushdown (Rope)** — upload `triceps-pushdown-rope.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a rope triceps pushdown: push the rope down until the arms are straight, spreading the two ends apart at the bottom, then let the hands rise back to chest height; the elbows stay pinned to the sides. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Leg Raise Parallel Bars (Weighted)** — upload `leg-raise-parallel-bars-weighted.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a weighted leg raise: raise both legs together, the plate held between the feet, until the thighs are above parallel, pause, then lower them slowly until they hang straight; the upper body stays braced on the arm pads. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Seated Incline Curl (Dumbbell)** — upload `seated-incline-curl-dumbbell.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of an incline dumbbell curl: curl both dumbbells up to the shoulders with the palms up while the upper arms hang still behind the body, then lower them until the arms hang straight. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Skullcrusher** — upload `skullcrusher.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a skullcrusher: bending only at the elbows, lower the EZ bar back behind the top of the head, then extend the arms to bring it back up above the face; the upper arms stay vertical and still. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Crunch (Cable)** — upload `crunch-cable.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a cable crunch: curl the torso down toward the thighs by contracting the abs, the elbows travelling toward the knees, then rise back until the spine is straight; the hips stay still and the rope stays taut. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Hammer Curl** — upload `hammer-curl.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a dumbbell hammer curl: curl both dumbbells up with the palms facing inward and the thumbs up until they reach the shoulders, then lower them until the arms are straight; the elbows stay pinned to the sides. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Triceps Dip (Weighted)** — upload `triceps-dip-weighted.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a weighted dip: lower the body by bending the elbows until the upper arms are parallel to the floor, then press back up until the arms are straight; the chain and plate hang beneath and the legs stay tucked. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

### Arms/Abs 2.0

**Bicep Curl (Dumbbell)** — upload `bicep-curl-dumbbell.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a dumbbell bicep curl: curl both dumbbells up to the shoulders with the palms turned up and the elbows pinned at the sides, then lower them until the arms hang straight. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Triceps Extension (Dumbbell)** — upload `triceps-extension-dumbbell.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a seated overhead triceps extension: holding the single dumbbell in both hands overhead, bend only at the elbows to lower it behind the head, then extend the arms to press it back up until they are straight; the upper arms stay pointing at the ceiling. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Hanging Leg Raise** — upload `hanging-leg-raise.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a hanging leg raise: from a dead hang, raise both straight legs together until they are level with the hips, pause, then lower them slowly until they hang straight down; no swinging. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Behind the Back Curl (Cable)** — upload `behind-the-back-curl-cable.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a behind the back cable curl: with the working arm starting behind the body and the cable running back to the low pulley, curl the handle forward and up to the shoulder, then lower it until the arm is straight behind the body again; the rest of the body stays still. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Triceps Pushdown** — upload `triceps-pushdown.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a straight bar triceps pushdown: push the bar down until the arms are locked out at the thighs, then let it rise back to chest height; the elbows stay pinned to the sides and the wrists stay straight. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Decline Sit Up** — upload `decline-sit-up.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a decline sit up: sit all the way up until the torso is nearly upright, then lower back down until the shoulders touch the bench; the feet stay hooked under the pads. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Hammer Curl (Machine)** — upload `hammer-curl-machine.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a machine hammer curl: curl both handles up with the palms facing each other until the hands reach the shoulders, pause, then lower until the arms are straight; the upper arms stay on the pad. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Seated Dip (Machine)** — upload `seated-dip-machine.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a seated dip: press both handles down until the arms are straight and locked, pause, then let them rise until the elbows are bent to ninety degrees; the weight stack rises and falls. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

### Morning workout

**Stair Machine (Steps)** — upload `stair-machine-steps.png` (re-slice first, see above)

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure with no red anywhere, the machine stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure climbs the moving stairs at a steady walking pace for the whole clip: one foot steps up after the other, the steps roll down under the feet, and the hands rest lightly on the rails. Finish with the feet where the image starts, so the clip loops.

**Glute Kickback (Machine)** — upload `glute-kickback-machine.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a machine glute kickback: drive the working leg back and up against the pad until the hip is fully extended, pause, then bring it forward until the knee is below the hip; the torso stays leaning on the chest pad and the standing leg stays still. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Back Extension** — see Back 1.0.

**Pull Through (Cable)** — upload `pull-through-cable.png`

> Animate this exact image, changing nothing about it: locked camera, solid black background, one grey figure, the red muscle stays red, the equipment stays as drawn, nothing and nobody else enters the frame, no sound, no text. The figure does slow, controlled repetitions of a cable pull through: drive the hips forward to stand tall as the rope swings forward between the thighs, then push the hips back and lean the torso forward as the rope travels back between the legs toward the pulley; the arms stay straight and the back stays flat. Repeat for the whole clip and finish in the pose the image starts in, so the clip loops.

**Romanian Deadlift** — see Legs 1.0.
