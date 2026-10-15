package com.cartergividen.plates.watch.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CompactButton
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.cartergividen.plates.watch.data.Stamp
import com.cartergividen.plates.watch.data.State
import com.cartergividen.plates.watch.logic.CodeEntry
import com.cartergividen.plates.watch.logic.WorkoutScreen
import com.cartergividen.plates.watch.logic.Workout
import kotlinx.coroutines.delay

@Composable
private fun Page(content: ScalingLazyListScope.() -> Unit) {
    val list = rememberScalingLazyListState()
    Scaffold(
        timeText = { TimeText() },
        positionIndicator = { PositionIndicator(scalingLazyListState = list) },
    ) {
        ScalingLazyColumn(
            state = list,
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
            content = content,
        )
    }
}

@Composable
private fun Caption(text: String) {
    Text(
        text, textAlign = TextAlign.Center, style = MaterialTheme.typography.caption2,
        color = MaterialTheme.colors.onSurfaceVariant, modifier = Modifier.padding(horizontal = 12.dp),
    )
}

// ---- pairing ----------------------------------------------------------------------

@Composable
fun PairScreen(vm: WatchViewModel) {
    val code by vm.code.collectAsState()
    val message by vm.pairing.collectAsState()

    Page {
        item { Text("Pair with Plates", style = MaterialTheme.typography.title3) }
        item { Caption("On your phone: Settings → Pair a watch → Get code") }
        item {
            Text(
                code.shown, fontSize = 22.sp, fontWeight = FontWeight.Medium,
                letterSpacing = 2.sp, modifier = Modifier.padding(vertical = 4.dp),
            )
        }
        message?.let { item { Caption(it) } }
        for (row in listOf(listOf(1, 2, 3), listOf(4, 5, 6), listOf(7, 8, 9))) {
            item { KeyRow(row.map { d -> d.toString() to { vm.press(d) } }) }
        }
        item {
            KeyRow(
                listOf(
                    "⌫" to vm::backspace,
                    "0" to { vm.press(0) },
                    (if (code.complete) "✓" else "") to vm::submitCode,
                ),
            )
        }
    }
}

@Composable
private fun KeyRow(keys: List<Pair<String, () -> Unit>>) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((label, onClick) in keys) {
            Button(
                onClick = onClick,
                enabled = label.isNotEmpty(),
                colors = ButtonDefaults.secondaryButtonColors(),
                modifier = Modifier.size(ButtonDefaults.SmallButtonSize),
            ) { Text(label, fontSize = 18.sp) }
        }
    }
}

// ---- home -------------------------------------------------------------------------

@Composable
fun HomeScreen(vm: WatchViewModel, state: State, email: String) {
    val status by vm.status.collectAsState()
    val routines = Workout.routines(state, email)

    Page {
        item { Text("Start a workout", style = MaterialTheme.typography.title3) }
        if (routines.isEmpty()) {
            item { Caption(if (status.busy) "Fetching your routines…" else "No routines yet — make one on the phone.") }
        }
        for (routine in routines) {
            item {
                Chip(
                    label = { Text(routine.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    onClick = { vm.start(routine) },
                    colors = ChipDefaults.primaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        item { Caption(statusLine(status)) }
        item {
            Chip(
                label = { Text("Unpair this watch") },
                onClick = vm::signOut,
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

private fun statusLine(status: SyncStatus): String = when {
    status.busy -> "Syncing…"
    status.pending > 0 && status.error != null -> "${status.pending} waiting — no connection"
    status.pending > 0 -> "${status.pending} waiting to sync"
    status.error != null -> "Offline"
    else -> "Synced"
}

// ---- the workout --------------------------------------------------------------------

@Composable
fun WorkoutScreenUi(vm: WatchViewModel, screen: WorkoutScreen) {
    val draft by vm.draft.collectAsState()
    val status by vm.status.collectAsState()
    val haptics = LocalHapticFeedback.current
    var confirmFinish by remember { mutableStateOf(false) }

    val current = screen.current
    val weight = if (current != null && draft?.setId == current.set.id) draft!!.weightLb else current?.weightLb
    val reps = if (current != null && draft?.setId == current.set.id) draft!!.reps else current?.reps

    Page {
        if (current != null) {
            item {
                Text(
                    current.set.exerciseName, textAlign = TextAlign.Center, maxLines = 2,
                    overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.title3,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
            item {
                Caption(
                    "Set ${current.number} of ${current.ofExercise}" +
                        (current.lastTime?.let { " · last $it" } ?: ""),
                )
            }
            item { Stepper(Workout.weightLabel(weight), "lb", { vm.stepWeight(-1) }, { vm.stepWeight(1) }) }
            item { Stepper(reps?.toString() ?: "—", "reps", { vm.stepReps(-1) }, { vm.stepReps(1) }) }
            item {
                Button(
                    onClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        vm.tick()
                    },
                    modifier = Modifier.size(ButtonDefaults.LargeButtonSize),
                ) { Text("✓", fontSize = 26.sp) }
            }
            screen.lastActivity?.let { item { RestClock(it) } }
        } else {
            item { Text("Plan done", style = MaterialTheme.typography.title3) }
            if (screen.cardioLeft > 0) item { Caption("${screen.cardioLeft} cardio left for the phone") }
            if (screen.lastSet != null) {
                item {
                    Chip(
                        label = { Text("One more set") },
                        secondaryLabel = { Text(screen.lastSet.exerciseName, maxLines = 1) },
                        onClick = vm::oneMore,
                        colors = ChipDefaults.primaryChipColors(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

        item { Caption("${screen.done} of ${screen.total} sets · ${statusLine(status)}") }

        if (screen.lastTicked != null) {
            item {
                Chip(
                    label = { Text("Undo last set") },
                    onClick = vm::undoLast,
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        item {
            Chip(
                label = { Text(if (confirmFinish) "Tap again to finish" else "Finish workout") },
                onClick = { if (confirmFinish) vm.finish() else confirmFinish = true },
                colors = if (confirmFinish) ChipDefaults.primaryChipColors() else ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun Stepper(value: String, unit: String, minus: () -> Unit, plus: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CompactButton(onClick = minus, colors = ButtonDefaults.secondaryButtonColors()) { Text("−") }
        Text("$value $unit", fontSize = 20.sp, fontWeight = FontWeight.Medium)
        CompactButton(onClick = plus, colors = ButtonDefaults.secondaryButtonColors()) { Text("+") }
    }
}

/** Time since the last tick — the rest you are taking. */
@Composable
private fun RestClock(since: String) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(since) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val seconds = ((now - Stamp.parse(since).toEpochMilli()) / 1000).coerceAtLeast(0)
    Caption("Rest %d:%02d".format(seconds / 60, seconds % 60))
}
