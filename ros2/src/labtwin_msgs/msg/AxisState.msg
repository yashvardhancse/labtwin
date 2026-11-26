# State of one linear axis, published at ~100 Hz.
string axis            # "x", "y" or "z"
float64 cmd_mm         # commanded position from the trajectory generator
float64 actual_mm      # measured (encoder) position
float64 velocity_mm_s  # measured velocity
bool homed
