"""Find the visible TikTok video area from Android accessibility geometry.

No pictures, titles, account names or credentials are retained. Unknown layouts
fail closed: a profile grid must never be mistaken for a playing video.
"""
import re
import xml.etree.ElementTree as ET


def video_region(xml, width, height):
    if width <= 0 or height <= 0 or len(xml) > 2_000_000:
        return None
    start, end = xml.find('<hierarchy'), xml.rfind('</hierarchy>')
    if start < 0 or end < start:
        return None
    try:
        root = ET.fromstring(xml[start:end + len('</hierarchy>')])
    except ET.ParseError:
        return None
    nodes = list(root.iter('node'))

    def bounds(node):
        values = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
        return tuple(map(int, values.groups())) if values else None

    candidates = []
    for node in nodes:
        # Native video interaction surface, not an arbitrary large container.
        if node.get('package') != 'com.zhiliaoapp.musically':
            continue
        if not node.get('resource-id', '').endswith(':id/long_press_layout'):
            continue
        b = bounds(node)
        if b and b[2] - b[0] >= width * .65 and b[3] - b[1] >= height * .4:
            candidates.append(b)
    if len(candidates) != 1:
        return None
    x1, y1, x2, y2 = candidates[0]
    # Exclude the native action/avatar rail using its current geometry. This
    # keeps tiny profile pictures out of inference without scaling the video.
    rail = [bounds(n) for n in nodes if n.get('class') == 'android.widget.Button'
            and n.get('package') == 'com.zhiliaoapp.musically']
    rail = [b for b in rail if b and b[0] > x1 + (x2-x1)*.7
            and b[2] <= x2 and y1 <= b[1] < b[3] <= y2]
    if len(rail) < 2:
        return None
    x2 = min(b[0] for b in rail)
    top_tabs = [bounds(n) for n in nodes if n.get('class') == 'android.widget.HorizontalScrollView']
    for b in top_tabs:
        if b and b[1] < height*.2 and b[3] < height*.25:
            y1 = max(y1, b[3])
    if min(x2-x1, y2-y1) < 64:
        return None
    return [max(0,x1/width), max(0,y1/height), min(1,x2/width), min(1,y2/height)]
