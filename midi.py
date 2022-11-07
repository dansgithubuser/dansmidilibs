import bisect
import math

class Msg:
    def note_on(num, vel=0x40, channel=0):
        assert 0 <= num <= 0xff
        assert 0 <= vel <= 0xff
        assert 0 <= channel <= 0xf
        return Msg(0x90 | channel, num, vel)

    def note_off(num, vel=0x40, channel=0):
        assert 0 <= num <= 0xff
        assert 0 <= vel <= 0xff
        assert 0 <= channel <= 0xf
        return Msg(0x80 | channel, num, vel)

    def tempo(us_per_quarter):
        assert 0 <= us_per_quarter <= 1 << 24
        return Msg(0xff, 0x51, 3, us_per_quarter.to_bytes(3, 'big'))

    def pitch_bend_range(semitones=2, cents=0, channel=0):
        assert 0 <= semitones <= 0xff
        assert 0 <= cents <= 0xff
        assert 0 <= channel <= 0xf
        return [
            Msg(0xb0 | channel, 0x65, 0),
            Msg(0xb0 | channel, 0x64, 0),
            Msg(0xb0 | channel, 0x06, semitones),
            Msg(0xb0 | channel, 0x26, cents),
        ]

    def __init__(self, *bytes_):
        self.bytes = bytes_

    def __eq__(self, other):
        return self.bytes == other.bytes

    def __iter__(self):
        return (i for i in self.bytes)

    def __str__(self, bare=False):
        if self.type_nibble() in [0x80, 0x90]:
            notes = [
                'C_', 'C#', 'D_', 'Eb', 'E_',
                'F_', 'F#', 'G_', 'Ab', 'A_', 'Bb', 'B_'
            ]
            note = notes[self.note() % 12]
            octave = str(self.note() // 12 - 1)
            result = '{:02x} {} {:02x}'.format(
                self.status(),
                note + octave,
                self.vel(),
            )
        else:
            result = ' '.join([f'{i:02x}' for i in self.bytes] + [self.type()])
        if not bare:
            result = f'<{result}>'
        return result

    def status(self):
        return self.bytes[0]

    def type_nibble(self):
        return self.status() & 0xf0

    def channel(self):
        if self.type_nibble() == 0xf0:
            raise Exception("system messages don't have a channel")
        return self.status() & 0x0f

    def vel(self):
        assert self.has_vel()
        return self.bytes[2]

    def has_vel(self):
        return self.type_nibble() in [0x80, 0x90]

    def note(self):
        assert self.has_note()
        return self.bytes[1]

    def has_note(self):
        return self.type_nibble() in [0x80, 0x90, 0xa0]

    def is_note_start(self):
        'Check if this msg is a note on with nonzero velocity.'
        return self.type_nibble() == 0x90 and self.bytes[2] != 0

    def is_note_end(self):
        'Check if this msg is a note on with 0 velocity, or a note off.'
        if self.type_nibble() == 0x80: return True
        if self.type_nibble() == 0x90 and self.bytes[2] == 0: return True
        return False

    def controller(self):
        assert self.is_control_change()
        return self.bytes[1]

    def control_value(self):
        assert self.is_control_change()
        return self.bytes[2]

    def is_control_change(self):
        return self.type_nibble() == 0xb0

    def tempo_us_per_quarter(self):
        assert self.type() == 'tempo'
        return int.from_bytes(self.bytes[3:6], 'big')

    def time_sig_top(self):
        assert self.type() == 'time_sig'
        return self.bytes[3]

    def time_sig_bottom(self):
        assert self.type() == 'time_sig'
        return 1 << self.bytes[4]

    def key_sig_sharps(self):
        assert self.type() == 'key_sig'
        r = self.bytes[3]
        if r & 0x80: r -= 0x100
        return r

    def key_sig_minor(self):
        assert self.type() == 'key_sig'
        return self.bytes[4]

    def is_meta(self):
        return self.status() == 0xff

    def meta_type(self):
        assert self.is_meta()
        return self.bytes[1]

    def type(self):
        if self.is_meta():
            return {
                0x00: 'sequence_number',
                0x01: 'text',
                0x02: 'copyright',
                0x03: 'track_name',
                0x04: 'instrument_name',
                0x05: 'lyric',
                0x06: 'marker',
                0x07: 'cue',
                0x20: 'channel_prefix',
                0x21: 'midi_port',
                0x2f: 'end_of_track',
                0x51: 'tempo',
                0x54: 'smpte_offset',
                0x58: 'time_sig',
                0x59: 'key_sig',
                0x7f: 'sequencer_specific',
            }.get(self.meta_type(), 'unknown')
        elif self.is_control_change():
            return 'control_change ' + {
                0x00: 'bank_select',
                0x01: 'mod_wheel',
                0x02: 'breath_control',
                0x04: 'foot_controller',
                0x06: 'data (RPN/NRPN)',
                0x07: 'volume',
                0x0a: 'pan',
                0x0b: 'expression',
                0x40: 'damper_pedal',
                0x41: 'portamento',
                0x47: 'resonance',
                0x4a: 'cutoff_frequency',
                0x5b: 'reverb',
                0x5c: 'tremolo',
                0x5d: 'chorus',
                0x5e: 'detune',
                0x5f: 'phaser',
                0x79: 'reset',
            }.get(self.controller(), 'unknown')
        return {
            0x80: 'note_off',
            0x90: 'note_on',
            0xa0: 'polyphonic_key_pressure',
            0xc0: 'program_change',
            0xd0: 'channel_pressure',
            0xe0: 'pitch_wheel_change',
            0xf0: 'system',
        }[self.type_nibble()]

    def transpose(self, semitones):
        assert self.has_note()
        assert 0 <= self.bytes[1] + semitones <= 0xff
        self.bytes[1] += semitones

    def set_vel(self, vel):
        assert self.has_vel()
        assert 0 <= vel <= 0xff
        self.bytes[2] = vel

class Deltamsg(Msg):
    def __init__(self, delta, bytes_, ticks=None, note_end=None):
        'A note end could be a note on with 0 velocity or a note off.'
        self.delta = delta
        Msg.__init__(self, *bytes_)
        self.ticks = ticks
        if note_end:
            self.set_note_end(note_end)
        else:
            self.note_end = None

    def __str__(self):
        return f'<{self.delta}; {Msg.__str__(self, bare=True)}>'

    def set_note_end(self, note_end):
        assert note_end().is_note_end()
        assert self.note() == note_end().note()
        if self.ticks != None and note_end().ticks:
            assert self.ticks <= note_end().ticks
        self.note_end = note_end

    def delta_bytes(self):
        result = []
        delta = self.delta
        for i in range(4):
            byte = delta & 0x7f
            delta >>= 7
            result = [byte] + result
            if delta == 0:
                for i in range(len(result) - 1): result[i] |= 0x80
                return result
        raise Exception('delta too big')

    def msg_bytes(self):
        return bytes(self.bytes)

    def duration(self):
        return self.note_end().ticks - self.ticks

    def vel_off(self):
        return self.note_end().vel()

    def transpose(self, semitones):
        Msg.transpose(self, semitones)
        if self.note_end:
            self.note_end().transpose(semitones)

    def durate(self, ticks):
        self.note_end.remove()
        i = self.note_end.track().add(self.note_end(), self.ticks + ticks)
        self.note_end().renorm(i)

class Track:
    def __init__(self, deltamsgs=None):
        if deltamsgs != None:
            self.deltamsgs = deltamsgs
        else:
            self.deltamsgs = []

    def __getitem__(self, i):
        return self.deltamsgs[i]

    def __len__(self):
        return len(self.deltamsgs)

    def append(self, deltamsg):
        if deltamsg.ticks == None:
            if self.deltamsgs:
                deltamsg.ticks = self[-1].ticks + deltamsg.delta
            else:
                deltamsg.ticks = deltamsg.delta
        self.deltamsgs.append(deltamsg)

    def redelta(self, i):
        'Recalculate deltamsgs[i].delta assuming ticks are correct.'
        if i == 0:
            ticks = 0
        else:
            ticks = self[i-1].ticks
        deltamsg = self[i]
        deltamsg.delta = deltamsg.ticks - ticks

    def add(self, msg, ticks):
        if not self.deltamsgs: self.append(Deltamsg(msg, ticks, ticks))
        deltamsg = Deltamsg(msg, None, ticks)
        key = lambda i: [i.ticks, *i.bytes]
        i = bisect.bisect(self.deltamsgs, key(deltamsg), key=key)
        self.deltamsgs.insert(i, deltamsg)
        self.redelta(i)
        self.redelta(i+1)
        return i

    def find(self, ticks, deltamsg_id=None):
        i = bisect.bisect_left(self.deltamsgs, ticks, key=lambda i: i.ticks)
        if deltamsg_id != None:
            while id(self[i]) != deltamsg_id:
                i += 1
                if i < 0: return
        return i

    def filter(self, predicate):
        result = Track()
        delta = 0
        for deltamsg in self:
            delta += deltamsg.delta
            if predicate(deltamsg):
                result.append(Deltamsg(delta, deltamsg.msg))
                delta = 0
        return result

class Song:
    def __init__(self, file_path=None, file_bytes=None, ticks_per_quarter=360, track_count=2):
        self.ticks_per_quarter = ticks_per_quarter
        self.tracks = [Track() for i in range(track_count)]
        if file_path or file_bytes:
            self.load(file_path, file_bytes)

    def __getitem__(self, i):
        return self.tracks[i]

    def __len__(self):
        return len(self.tracks)

    def save(self, file_path):
        with open(file_path, 'wb') as file:
            header = (
                b'MThd'
                + bytes([0, 0, 0, 6, 0, 1])
                + len(self.tracks).to_bytes(2, 'big')
                + self.ticks_per_quarter.to_bytes(2, 'big')
            )
            file.write(header)
            for track in self.tracks:
                track_bytes = []
                for deltamsg in track:
                    track_bytes.extend(deltamsg.delta_bytes())
                    track_bytes.extend(deltamsg.msg_bytes())
                if track_bytes[-4:] != [0x01, 0xff, 0x2f, 0x00]:
                    track_bytes += [0x01, 0xff, 0x2f, 0x00]
                track_header = b'MTrk' + len(track_bytes).to_bytes(4, 'big')
                file.write(track_header + bytes(track_bytes))

    def load(self, file_path=None, file_bytes=None):
        # arg checks
        if file_path and file_bytes:
            raise Exception('cannot specify file more than one way')
        if file_path:
            with open(file_path, 'rb') as file: file_bytes = file.read()
        elif file_bytes:
            file_bytes = bytes(file_bytes)
        else:
            raise Exception('must specify file')
        # get chunks
        index = 0
        chunks = []
        chunk_id_size = 4
        chunk_size_size = 4
        chunk_id_header = b'MThd'
        chunk_id_track = b'MTrk'
        # get header chunk
        header_size = chunk_id_size + chunk_size_size + 6
        if len(file_bytes) < header_size:
            raise Exception('first chunk too short')
        chunk_id = file_bytes[:chunk_id_size]
        if chunk_id != chunk_id_header:
            raise(Exception(f'first chunk ID should be {chunk_id_header}, but got {chunk_id}'))
        chunks.append(file_bytes[:header_size])
        index += header_size
        # get track chunks
        while True:
            index_data = index + chunk_id_size + chunk_size_size
            if len(file_bytes) < index_data: break
            chunk_id = file_bytes[index:index+chunk_id_size]
            if chunk_id != chunk_id_track:
                raise Exception('chunk ID should be {chunk_id_track}, but got {chunk_id}')
            track_size = int.from_bytes(file_bytes[index+4:index+8], 'big')
            track_end = index_data + track_size
            if len(file_bytes) < track_end:
                raise Exception('track too long')
            chunks.append(file_bytes[index:track_end])
            index = track_end
        if index != len(file_bytes): raise Exception('malformed tracks')
        # handle header chunk
        if int.from_bytes(chunks[0][8:10], 'big') != 1:
            raise Exception('unhandled file type')
        if int.from_bytes(chunks[0][10:12], 'big') != len(chunks) - 1:
            raise Exception('wrong number of tracks')
        self.ticks_per_quarter = int.from_bytes(chunks[0][12:14], 'big')
        # handle track chunks
        self.tracks.clear()
        for chunk in chunks[1:]:
            track = Track()
            index = chunk_id_size + chunk_size_size
            running_status = None
            while index < len(chunk):
                # delta
                delta = 0
                for i in range(index, index+4):
                    delta <<= 7
                    delta += chunk[i] & 0x7f
                    if not chunk[i] & 0x80: break
                else: raise Exception('delta too big')
                index = i+1
                # msg - status
                if chunk[index] & 0x80:
                    status = chunk[index]
                    if chunk[index] & 0xf0 != 0xf0:
                        running_status = status
                    index += 1
                else:
                    if not running_status: raise Exception('no status')
                    status = running_status
                # msg - data
                if status & 0xf0 in [0x80, 0x90, 0xa0, 0xb0, 0xe0]:
                    data = chunk[index:index+2]
                    index += 2
                elif status & 0xf0 in [0xc0, 0xd0]:
                    data = chunk[index:index+1]
                    index += 1
                elif status & 0xf0 == 0xf0:
                    if status == 0xff:
                        data_size = 2 + chunk[index+1]
                        data = chunk[index:index+data_size]
                        index += data_size
                    else:
                        data = []
                # deltamsg
                deltamsg = Deltamsg(delta, bytes([status]) + data)
                track.append(deltamsg)
            if track[-1] != Msg(0xff, 0x2f, 0x00):
                raise Exception('invalid last msg')
            self.tracks.append(track)
            # note ends
            for i, v in enumerate(track):
                if not v.is_note_start(): continue
                for j, u in enumerate(track[i+1:]):
                    if u.is_note_end() and u.note() == v.note():
                        v.set_note_end(Ref(self, len(self.tracks)-1, i+1+j))
                        break
        return self

    def add_note(self, track_index, ticks, duration, num, channel=None, vel_on=0x40, vel_off=0x40):
        if channel == None:
            assert track_index != 0
            channel = track_index - 1
        on = self.tracks[track_index].add(Msg.note_on(num, vel_on, channel), ticks)
        off = self.tracks[track_index].add(Msg.note_off(num, vel_off, channel), ticks + duration)
        Ref(self, track_index, on)().set_note_end(Ref(self, track_index, off))

    def prev(self, track_index, ticks, predicate=None):
        track = self.tracks[track_index]
        i = bisect.bisect_left(track, ticks, key=lambda i: i.ticks) - 1
        while True:
            if i < 0:
                return
            if predicate == None or predicate(track[i]):
                return Ref(self, track_index, i)
            i -= 1

    def select(
        self,
        track_index_i=0,
        track_index_f=None,
        ticks_i=0,
        ticks_f=math.inf,
        note_i=None,
        note_f=None,
        predicate=None,
    ):
        if track_index_f == None:
            track_index_f = track_index_i
        if note_i != None and note_f == None:
            note_f = note_i
        result = []
        for track_index in range(track_index_i, track_index_f):
            track = self.tracks[track_index]
            i = bisect.bisect_left(track, ticks_i, key=lambda i: i.ticks)
            while i < len(track):
                deltamsg = track[i]
                deltamsg_index = i
                if deltamsg.ticks >= ticks_f: break
                i += 1
                if deltamsg.ticks < ticks_i: continue
                if predicate != None and not predicate(deltamsg): continue
                if note_i != None and deltamsg.has_note() and not note_i <= deltamsg.note() <= note_f: continue
                result.append(Ref(self, track_index, deltamsg_index))
        return result

    def filterleave(self, predicate):
        'Filter each track, then interleave them. Useful to get all msgs of a specific type into one track.'
        return interleave(i.filter(predicate) for i in self.tracks)

class Ref:
    def __init__(self, song, track_index, deltamsg_index):
        self.song = song
        self.track_index = track_index
        self.deltamsg_index = deltamsg_index
        self.deltamsg = None

    def __call__(self):
        if self.deltamsg:
            return self.deltamsg
        else:
            return self.track()[self.deltamsg_index]

    def track(self):
        return self.song[self.track_index]

    def remove(self):
        self.denorm()
        if self.deltamsg.note_end:
            self.deltamsg.note_end.remove()
        del self.track()[self.deltamsg_index]
        self.track()[self.deltamsg_index].redelta()
        self.deltamsg_index = None

    def denorm(self):
        self.deltamsg = self()
        if self.deltamsg.note_end:
            self.deltamsg.note_end.denorm()

    def renorm(self, deltamsg_index=None):
        if deltamsg_index != None:
            self.deltamsg_index = deltamsg_index
        else:
            self.deltamsg_index = self.track().find(self.deltamsg.ticks, id(self.deltamsg))
        self.deltamsg = None
        if self().note_end:
            self().note_end.renorm()

class TrackIter:
    'Track iterator that makes it easier to coordinate iteration over multiple tracks.'

    def __init__(self, track):
        self.track = track
        self.i = 0
        self.ticks_last = 0
        self.ticks_curr = 0

    def stopped(self):
        return self.i >= len(self.track)

    def delta(self):
        "Returns the delta to the next msg in the track, or infinity if there's no next msg."
        if self.stopped(): return math.inf
        result = (
            self.track[self.i].delta
            - (self.ticks_curr - self.ticks_last)
        )
        if result < 0:
            raise Exception('invalid iteration')
        return result

    def advance(self, delta, interleave=False):
        "Advance by specified delta and return a deltamsg if we've come to one. If interleave is true, its delta will be set to the one supplied."
        self.ticks_curr += delta
        if not self.delta():
            # advance to next msg
            deltamsg = self.track[self.i]
            self.i += 1
            self.ticks_last += deltamsg.delta
            if interleave: return Deltamsg(delta, deltamsg.msg)
            return deltamsg

def interleave(*tracks):
    'Turn many tracks into one.'
    result = Track()
    iters = [TrackIter(i) for i in tracks]
    while not all(i.stopped() for i in iters):
        delta = min(i.delta for i in iters)
        first = True
        for j in [i.advance(delta, True) for i in iters]:
            if deltamsg := j:
                if first:
                    # advance by delta
                    first = False
                    result.append(deltamsg)
                else:
                    # these msgs happen at the same time, so zero delta
                    result.append(Deltamsg(0, deltamsg.msg))
    return result

def print_vertical(*tracks):
    iters = [TrackIter(i) for i in tracks]
    ticks = 0
    while not all(i.stopped() for i in iters):
        delta = min(i.delta() for i in iters)
        ticks += delta
        print(f'{ticks:>8};', end=' ')
        for k, j in enumerate([i.advance(delta) for i in iters]):
            if deltamsg := j:
                s = Msg.__str__(j, bare=True)
            else:
                s = '-'
            print(f'{s:<19}', end=' ')
            if len(s) > 19:
                print()
                print(' ' * (10 + 20 * (k + 1)), end='')
        print()
