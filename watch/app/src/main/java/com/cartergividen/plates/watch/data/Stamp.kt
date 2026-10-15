package com.cartergividen.plates.watch.data

import java.time.Instant
import java.time.OffsetDateTime

/**
 * Timestamps as moments, not strings.
 *
 * Postgres sends "2026-10-14T20:31:00.123456+00:00", the phone writes
 * "2026-10-14T20:31:00.123Z", and this app writes whatever [Instant.toString]
 * gives. As strings those disagree about order ('Z' sorts after '+'), which
 * would hand last-write-wins to whichever device spelled its offset later.
 */
object Stamp {
    fun parse(iso: String): Instant = OffsetDateTime.parse(iso).toInstant()

    fun now(clock: () -> Instant = Instant::now): String = clock().toString()

    /** True when [a] is strictly later than [b]. */
    fun after(a: String, b: String): Boolean = parse(a).isAfter(parse(b))

    fun latest(stamps: Iterable<String>): String? = stamps.maxByOrNull { parse(it) }
}
