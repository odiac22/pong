"""Synthetic scheduling/safety tests. Not TikTok performance qualification."""
import asyncio
import unittest
import time
import numpy as np
from server import Session
from test_server import FakeEmulator


class FakeSwap:
    def __init__(self):
        self.enabled=True; self.revision=0; self.error=None
        self.started=asyncio.Event();self.finish=asyncio.Event()
        self.sequences=[];self.closed=False;self.new_videos=0

    async def render(self,rgb,seq,stamp):
        revision=self.revision;self.sequences.append(seq);self.started.set()
        await self.finish.wait()
        if revision!=self.revision or not self.enabled:return None
        return rgb.copy()+1,True

    def reset(self,suspend=False):
        self.revision+=1
        if suspend:self.enabled=False

    def begin_video(self):self.new_videos+=1
    def status(self):return {'enabled':self.enabled}
    async def close(self):self.closed=True
    async def configure(self, body, width, height):
        self.configuration = body
        self.enabled = bool(body.get('enabled'))
        return self.status()


class SwapPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_automatic_region_uses_verified_geometry_without_manual_mark(self):
        emulator=FakeEmulator()
        async def region():return [0,.1,.8,.9]
        emulator.video_region=region
        bridge=FakeSwap();session=Session(emulator,bridge)
        session.raw_latest=(np.zeros((100,100,3),np.uint8),1,1,time.perf_counter())
        await session.configure_swap({'enabled':True,'automaticRegion':True,'faceId':'approved-fixture'})
        self.assertEqual(bridge.configuration['roi'],[0,.1,.8,.9])
        self.assertTrue(bridge.configuration['regionConfirmed'])
        await session.close()

    async def test_profile_does_not_enable_but_video_reentry_resumes_selected_face(self):
        emulator=FakeEmulator();current=None
        async def region():return current
        emulator.video_region=region
        bridge=FakeSwap();bridge.enabled=False;session=Session(emulator,bridge)
        session.raw_latest=(np.zeros((100,100,3),np.uint8),1,1,time.perf_counter())
        with self.assertRaises(ValueError):
            await session.configure_swap({'enabled':True,'automaticRegion':True,'faceId':'approved-fixture'})
        self.assertFalse(bridge.enabled)
        current=[0,.1,.8,.9]
        await session.refresh_region(resume=True)
        self.assertTrue(bridge.enabled)
        self.assertEqual(bridge.configuration['faceId'],'approved-fixture')
        await session.close()

    async def test_stale_layout_result_cannot_enable_a_swap_after_navigation(self):
        emulator=FakeEmulator();started=asyncio.Event();finish=asyncio.Event()
        async def region():started.set();await finish.wait();return [0,.1,.8,.9]
        emulator.video_region=region
        bridge=FakeSwap();bridge.enabled=False;session=Session(emulator,bridge)
        session.auto_face='approved-fixture'
        session.raw_latest=(np.zeros((100,100,3),np.uint8),1,1,time.perf_counter())
        task=asyncio.create_task(session.refresh_region(resume=True))
        await started.wait();session.region_epoch+=1;finish.set();await task
        self.assertFalse(bridge.enabled);self.assertIsNone(session.region)
        await session.close()

    async def test_original_cancels_auto_resume(self):
        session=Session(FakeEmulator(),FakeSwap())
        session.auto_face='approved-fixture'
        session.raw_latest=(np.zeros((100,100,3),np.uint8),1,1,time.perf_counter())
        await session.configure_swap({'enabled':False})
        self.assertIsNone(session.auto_face);self.assertFalse(session.swap_bridge.enabled)
        await session.close()

    async def test_slow_renderer_does_not_block_input_and_stale_frame_is_dropped(self):
        emulator=FakeEmulator();bridge=FakeSwap();session=Session(emulator,bridge)
        frame=np.zeros((64,64,3),np.uint8)
        session.raw_latest=(frame,1,1,time.perf_counter())
        render=asyncio.create_task(session.render());control=asyncio.create_task(session.control())
        session.tasks=[render,control]
        session.render_changed.set()
        await asyncio.wait_for(bridge.started.wait(),1)
        session.inputs.put_nowait(({'type':'touch','seq':1,'action':'down','x':.5,'y':.8},time.perf_counter()))
        for _ in range(100):
            if emulator.inputs:break
            await asyncio.sleep(.001)
        self.assertEqual(emulator.inputs,[(.5,.8,1)])
        bridge.finish.set();await asyncio.sleep(.01)
        self.assertIsNone(session.latest)
        await session.close();self.assertTrue(bridge.closed)

    async def test_waiting_captures_are_replaced_not_queued(self):
        bridge=FakeSwap();session=Session(FakeEmulator(),bridge)
        frame=np.zeros((64,64,3),np.uint8)
        session.raw_latest=(frame,1,1,time.perf_counter())
        task=asyncio.create_task(session.render());session.tasks=[task];session.render_changed.set()
        await asyncio.wait_for(bridge.started.wait(),1)
        for seq in range(2,21):
            session.raw_latest=(frame,seq,seq,time.perf_counter());session.render_changed.set()
        bridge.finish.set();await asyncio.sleep(.01)
        self.assertEqual(bridge.sequences,[1,20]);self.assertEqual(session.latest[1],20)
        await session.close()

    async def test_vertical_swipe_resets_video_and_horizontal_navigation_suspends(self):
        for destination,enabled in [((.5,.2),True),((.1,.8),False)]:
            bridge=FakeSwap();emulator=FakeEmulator();session=Session(emulator,bridge)
            task=asyncio.create_task(session.control());session.tasks=[task]
            session.inputs.put_nowait(({'type':'touch','seq':1,'action':'down','x':.5,'y':.8},time.perf_counter()))
            session.inputs.put_nowait(({'type':'touch','seq':2,'action':'up','x':destination[0],'y':destination[1]},time.perf_counter()))
            for _ in range(100):
                if len(emulator.inputs)==2:break
                await asyncio.sleep(.001)
            self.assertEqual(bridge.enabled,enabled)
            self.assertEqual(bridge.new_videos,int(enabled));self.assertIsNone(session.latest)
            await session.close()


if __name__=='__main__':unittest.main()
