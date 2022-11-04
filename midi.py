import math

class Msg:
    def pitch_bend_range(semitones=2, cents=0):
        return [
            Msg(0xb0, 0x65, 0),
            Msg(0xb0, 0x64, 0),
            Msg(0xb0, 0x06, semitones),
            Msg(0xb0, 0x26, cents),
        ]

    def __init__(self, *bytes_):
        self.bytes = bytes_

    def __eq__(self, other):
        return self.bytes == other.bytes

    def __iter__(self):
        return (i for i in self.bytes)

    def __repr__(self):
        if self.type_nibble() in [0x80, 0x90]:
            notes = [
                'C_', 'C#', 'D_', 'Eb', 'E_',
                'F_', 'F#', 'G_', 'Ab', 'A_', 'Bb', 'B '
            ]
            note = notes[self.note() % 12]
            octave = str(self.note() // 12 - 1)
            return '{:02x} {} {:02x}'.format(
                self.status(),
                note + octave,
                self.velocity(),
            )
        else:
            return ' '.join([f'{i:02x}' for i in self])

    def __str__(self):
        return str(list(self))

    def status(self):
        return self[0]

    def type_nibble(self):
        return self.status() & 0xf0

    def channel(self):
        if self.type_nibble() == 0xf0:
            raise Exception("system messages don't have a channel")
        return self.status() & 0x0f

    def note(self):
        if self.type_nibble() not in [0x80, 0x90, 0xa0]:
            raise Exception('no note')
        return self[1]

    def velocity(self):
        if self.type_nibble() not in [0x80, 0x90]:
            raise Exception('no velocity')
        return self[2]

    def is_note_end(self):
        if self.type_nibble() == 0x80: return True
        if self.type_nibble() == 0x90 and self[2] == 0: return True
        return False

    def tempo_us_per_quarter(self):
        assert self.type() == 'tempo'
        return int.from_bytes(self[3:6], 'big')

    def time_sig_top(self):
        assert self.type() == 'time_sig'
        return self[3]

    def time_sig_bottom(self):
        assert self.type() == 'time_sig'
        return 1 << self[4]

    def key_sig_sharps(self):
        assert self.type() == 'key_sig'
        r = self[3]
        if r & 0x80: r -= 0x100
        return r

    def key_sig_minor(self):
        assert self.type() == 'key_sig'
        return self[4]

    def meta_type(self):
        if self.status() != 0xff:
            raise Exception('not meta')
        return self[1]

    def type(self):
        if self.status() == 0xff:
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
                0x2f: 'end_of_track',
                0x51: 'tempo',
                0x54: 'smpte_offset',
                0x58: 'time_sig',
                0x59: 'key_sig',
                0x7f: 'sequencer_specific',
            }.get(self.meta_type(), 'unknown')
        return {
            0x80: 'note_off',
            0x90: 'note_on',
            0xa0: 'polyphonic_key_pressure',
            0xb0: 'control_change',
            0xc0: 'program_change',
            0xd0: 'channel_pressure',
            0xe0: 'pitch_wheel_change',
            0xf0: 'system',
        }[self.type_nibble()]

class Deltamsg(Msg):
    def __init__(self, delta, bytes_, ticks=None, note_end=None):
        self.delta = delta
        Msg.__init__(self, *bytes_)
        self.ticks = ticks
        self.note_end = note_end

    def __repr__(self):
        return '{}; {}'.format(
            self.delta,
            self.msg,
        )

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
        return self.note_end.ticks - self.ticks

    def _track_order(self):
        return [self.ticks, *self.bytes]

class Track:
    def __init__(self, deltamsgs=[]):
        self.deltamsgs = deltamsgs

    def append(self, deltamsg):
        if deltamsg.ticks == None:
            if self.deltamsgs:
                deltamsg.ticks = self.deltamsgs[-1].ticks + deltamsg.delta
            else:
                deltamsg.ticks = deltamsg.delta
        self.deltamsgs.append(deltamsg)

    def redelta(self, i):
        if i == 0:
            ticks = 0
        else:
            ticks = self.deltamsgs[i-1].ticks
        deltamsg = self.deltamsgs[i]
        deltamsg.delta = deltamsg.ticks - ticks

    def insert(self, msg, ticks):
        if not self.deltamsgs: self.append(Deltamsg(msg, ticks, ticks))
        lo = 0
        hi = len(self.deltamsgs) - 1
        deltamsg = Deltamsg(msg, None, ticks)
        while True:
            mid = (lo + hi) // 2
            other = self.deltamsgs[mid]
            if deltamsg._track_order() == other._track_order():
                i = mid
                break
            if deltamsg._track_order() < other._track_order():
                hi = mid
            else:
                lo = mid
            if hi - lo == 1:
                i = hi
                break
        self.deltamsgs.insert(i, deltamsg)
        self.redelta(i)
        self.redelta(i+1)

    def filter(self, types):
        result = Track()
        delta = 0
        for deltamsg in self:
            delta += deltamsg.delta
            if deltamsg.type() in types:
                result.append(Deltamsg(delta, deltamsg.msg))
                delta = 0
        return result

class Song:
    def __init__(self, file_path=None, file_bytes=None, ticks_per_quarter=360):
        self.ticks_per_quarter = ticks_per_quarter
        self.tracks = []
        if file_path or file_bytes:
            self.load(file_path, file_bytes)

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
        if file_path and file_bytes:
            raise Exception('cannot specify file more than one way')
        if file_path:
            with open(file_path, 'rb') as file: file_bytes = file.read()
        elif file_bytes:
            file_bytes = bytes(file_bytes)
        else:
            raise Exception('must specify file')
        # get chunks
        header_length = 14
        header_title = b'MThd'
        if len(file_bytes) < header_length:
            raise Exception('header too short')
        if file_bytes[0:len(header_title)] != header_title:
            raise(Exception(f'header title should be {header_title}, but got {file_bytes[0:len(header_title)]}'))
        chunks = [file_bytes[:header_length]]
        track_header_size = 8
        track_title = b'MTrk'
        index = header_length
        while len(file_bytes) >= index + track_header_size:
            if file_bytes[index:index+len(track_title)] != track_title:
                raise Exception('bad track header')
            track_size = int.from_bytes(file_bytes[index+4:index+8], 'big')
            if len(file_bytes) < index + track_header_size + track_size:
                raise Exception('track too long')
            chunks.append(file_bytes[index:index+track_header_size+track_size])
            index += track_header_size + track_size
        if index != len(file_bytes): raise Exception('malformed tracks')
        if int.from_bytes(file_bytes[10:12], 'big') != len(chunks) - 1:
            raise Exception('bad size')
        # handle chunk 0
        self.ticks_per_quarter = int.from_bytes(chunks[0][12:14], 'big')
        if int.from_bytes(chunks[0][8:10], 'big') != 1:
            raise Exception('unhandled file type')
        if int.from_bytes(chunks[0][10:12], 'big') != len(chunks) - 1:
            raise Exception('wrong number of tracks')
        # turn other chunks into a tracks
        self.tracks.clear()
        for chunk in chunks[1:]:
            track = Track()
            index = _track_header_size
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
            if track[-1].msg != Msg(0xff, 0x2f, 0x00):
                raise Exception('invalid last msg')
            for i, v in enumerate(track):
                if v.type() != 'note_on': continue
                for u in track[i+1:]:
                    if u.is_note_end() and u.note() == v.note():
                        v.note_end = u
                        break
            self.tracks.append(track)
        return self

    def filterleave(self, types):
        return interleave(i.filter(types) for i in self.tracks)

class TrackIter:
    def __init__(self, track):
        self.track = track
        self.i = 0
        self.ticks_last = 0
        self.ticks_curr = 0

    def more(self):
        return self.i < len(self.track)

    def delta(self):
        if self.i >= len(self.track): return math.inf
        result = (
            self.track[self.i].delta
            - (self.ticks_curr - self.ticks_last)
        )
        if result < 0:
            raise Exception('invalid iteration')
        return result

    def advance(self, delta, interleave=False):
        self.ticks_curr += delta
        if not self.delta:
            deltamsg = self.track[self.i]
            self.i += 1
            self.ticks_last += deltamsg.delta
            if interleave: return Deltamsg(delta, deltamsg.msg)
            return deltamsg

def interleave(*tracks):
    result = Track()
    iters = [TrackIter(i) for i in tracks]
    while any(i.more() for i in iters):
        delta = min(i.delta for i in iters)
        first = True
        for i in [i.advance(delta, True) for i in iters]:
            if i:
                if first:
                    first = False
                    result.append(i)
                else:
                    result.append(Deltamsg(0, i.msg))
    return result

def print_vertical(*tracks):
    iters = [TrackIter(i) for i in tracks]
    ticks = 0
    while any(i.more() for i in iters):
        delta = min(i.delta for i in iters)
        ticks += delta
        print(f'{ticks:>10}', end='')
        for i in [i.advance(delta) for i in iters]:
            if i:
                s = repr(i)
            else:
                s = '-'
            print(f'{s:>30}', end='')
        print()
