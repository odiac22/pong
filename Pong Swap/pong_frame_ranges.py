"""Bounded, output-frame evidence; not a claim based on session totals."""
def append_transformed_range(ranges, frame_index, limit=256):
    frame_index = int(frame_index)
    if frame_index < 0:
        return
    if ranges and frame_index == ranges[-1][1] + 1:
        ranges[-1] = [ranges[-1][0], frame_index]
    elif not ranges or frame_index > ranges[-1][1]:
        ranges.append([frame_index, frame_index])
    if len(ranges) > limit:
        del ranges[:-limit]
