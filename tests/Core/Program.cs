using JellyfinParty;
int checks = 0;
void Check(bool condition, string name) { if (!condition) throw new Exception(name); checks++; }
var timeline = new Timeline(100, 1000);
Check(timeline.Paused && timeline.At(5000) == 0, "Paused initial state");
Check(timeline.Apply("play", 0, 0, 5000), "Play accepted");
Check(timeline.At(6500) == 1.5, "Timeline advances on server clock");
Check(!timeline.Apply("seek", 80, 0, 6500) && timeline.Revision == 1, "Stale seek rejected");
Check(timeline.Apply("seek", 200, 1, 6500) && timeline.At(7000) == 100, "Seek clamped to duration");
Check(timeline.Apply("pause", 0, 2, 7000) && timeline.Paused, "Pause accepted");
Check(timeline.At(99999) == 100, "Paused position stable");
Check(timeline.Apply("seek", -10, 3, 99999) && timeline.Position == 0 && timeline.Paused, "Negative seek clamped without unpausing");
Check(!timeline.Apply("seek", double.NaN, 4, 99999), "Non-finite position rejected");
Check(!timeline.Apply("delete", 0, 4, 99999), "Unknown command rejected");
Console.WriteLine($"PASS: {checks} authoritative timeline assertions.");
