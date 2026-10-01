import unittest
from video_region import video_region


def layout(extra='', package='com.zhiliaoapp.musically', surface=True):
    return '<hierarchy>' + (
        f'<node package="{package}" resource-id="{package}:id/long_press_layout" bounds="[0,0][1080,2139]"/>' if surface else '') + ''.join(
        f'<node package="{package}" class="android.widget.Button" bounds="[914,{y}][1080,{y+100}]"/>' for y in [1300,1450]) + extra + '</hierarchy>'


class VideoRegionTests(unittest.TestCase):
    def test_video_excludes_avatar_rail_and_navigation(self):
        roi=video_region(layout('<node class="android.widget.HorizontalScrollView" bounds="[165,145][915,305]"/>'),1080,2340)
        self.assertEqual(roi, [0,305/2340,914/1080,2139/2340])

    def test_profile_grid_and_other_apps_are_not_videos(self):
        self.assertIsNone(video_region(layout(surface=False),1080,2340))
        self.assertIsNone(video_region(layout(package='other.app'),1080,2340))

    def test_unknown_or_ambiguous_layout_fails_closed(self):
        self.assertIsNone(video_region('broken',1080,2340))
        self.assertIsNone(video_region(layout().replace('</hierarchy>',layout()+'</hierarchy>'),1080,2340))
        self.assertIsNone(video_region(layout(),0,2340))

    def test_pixel_bounds_are_normalized_not_fixed_resolution(self):
        xml=layout().replace('1080','540').replace('914','457').replace('2139','1069').replace('1300','650').replace('1400','700').replace('1450','725').replace('1550','775')
        self.assertAlmostEqual(video_region(xml,540,1170)[2],457/540)


if __name__ == '__main__': unittest.main()
