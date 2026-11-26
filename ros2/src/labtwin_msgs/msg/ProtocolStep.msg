# A protocol step transition (mirrors action_msgs/GoalStatus semantics).
uint32 index
string type      # home, move, aspirate, dispense, wait, cool_stage
string status    # executing, succeeded, aborted, canceled
uint32 line      # 1-based source line in the protocol YAML
string label
