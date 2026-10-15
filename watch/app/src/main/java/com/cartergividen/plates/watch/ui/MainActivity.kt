package com.cartergividen.plates.watch.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.wear.compose.material.MaterialTheme
import com.cartergividen.plates.watch.logic.workoutScreen

class MainActivity : ComponentActivity() {
    private val vm: WatchViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                val session by vm.session.collectAsState()
                val state by vm.stateFlow.collectAsState()
                val me = session?.email

                when {
                    me == null -> PairScreen(vm)
                    else -> {
                        val workout = workoutScreen(state, me)
                        if (workout != null) WorkoutScreenUi(vm, workout)
                        else HomeScreen(vm, state, me)
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        vm.foreground(true)
    }

    override fun onPause() {
        vm.foreground(false)
        super.onPause()
    }
}
