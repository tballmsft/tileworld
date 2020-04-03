namespace tileworld {


    enum SpriteState { Alive, Dead, }

    // a TileSprite is centered on a 16x16 pixel tile
    class TileSprite extends Sprite {
        public debug: boolean;
        public state: SpriteState;
        public dir: MoveDirection;  // the direction the sprite moved in the last round
        public inst: number;        // the one instruction history to apply to the sprite to 
        public arg: number;         // create the next sprite state
        constructor(img: Image, kind: number, d: boolean = false) {
            super(img);
            const scene = game.currentScene();
            scene.physicsEngine.addSprite(this);
            this.setKind(kind);
            this.debug = d;
            this.dir = -1;
            this.inst = -1;
            this.state = SpriteState.Alive;
        }
        public col() { return this.x >> 4; }    // the position of sprite in tile world
        public row() { return this.y >> 4; }    // coordinates
        public update() {
            // update the state of the sprite base on instruction
            this.dir = this.inst == CommandType.Move && this.arg < MoveArg.Stop  ? this.arg : -1;
            this.vx = this.dir == MoveDirection.Left ? -100 : this.dir == MoveDirection.Right ? 100 : 0;
            this.vy = this.dir == MoveDirection.Up ? -100 : this.dir == MoveDirection.Down ? 100 : 0;
        }
        isOutOfScreen(camera: scene.Camera): boolean {
            const ox = (this.flags & sprites.Flag.RelativeToCamera) ? 0 : camera.drawOffsetX;
            const oy = (this.flags & sprites.Flag.RelativeToCamera) ? 0 : camera.drawOffsetY;
            return this.right - ox < (this.debug ? 32 : 0) || this.bottom - oy < 0 || 
                   this.left - ox > screen.width - (this.debug ? 32 : 0) || this.top - oy > screen.height;
        }
        // still need to translate properly
        __drawCore(camera: scene.Camera) {
            if (this.isOutOfScreen(camera)) return;

            const ox = (this.flags & sprites.Flag.RelativeToCamera) ? 0 : camera.drawOffsetX;
            const oy = (this.flags & sprites.Flag.RelativeToCamera) ? 0 : camera.drawOffsetY;

            const l = this.left - ox + (this.debug ? 32 : 0);
            const t = this.top - oy;

            screen.drawTransparentImage(this.image(), l, t)
        }
    }

    // used to record effect of paint tile commands in a small log
    class PaintTile {
        constructor(public col: number, public row: number, public tile: number) {
        }
    }

    enum GameState { InPlay, Won, Lost, };

    // the interpreter state
    class VMState {
        public game: GameState;             // see type   
        public paintTile: PaintTile[];      // log of paint commands
        public nextWorld: Image;            // record all paint commands (if log exceeded)
        public changed: Image;              // what changed in last round
        public sprites: TileSprite[][];     // the sprites, sorted by kind
        public deadSprites: TileSprite[];   // the sprites removed by this round
        // during evaluating
        public buttonMatch: TileSprite[];   // which sprites had a button event rule (external influence)
        public phase: RuleType;
        public queued: TileSprite[];
        constructor() {}
    }

    // rule (rid) plus binding of self and other sprite, in preparation
    // for the evalation of rule's commands 
    class RuleClosure {
        constructor(
            public rid: number,
            public self: TileSprite,
            public witnesses: TileSprite[]) {
        }
    }

    class TileWorldVM {
        private vm: VMState;
        private dpad: number[];
        // (temporary) state for global commands
        private globalInsts: number[];
        private globalArgs: number[];
        private allTrueResting: number[] = [];
        private ruleIndex: number[][] = [];     // lookup of rules by phase
        
        constructor(private p: Project, private rules: number[]) {
            this.vm = null;
            for (let i = RuleType.FirstRule; i<= RuleType.LastRule; i++) {
                this.ruleIndex[i] = [];
            }
            // populate indices for more efficient lookup
            this.rules.forEach(rid => {
                if (this.p.isRestingRule(rid) && this.p.allTrue(rid))
                    this.allTrueResting.push(rid);
                else
                    this.ruleIndex[this.p.getRuleType(rid)].push(rid);
            });
        }

        public setState(v: VMState) {
            this.vm = v;
        }

        public startRound(currDir: number[]) {
            if (!this.vm)
                return;
            this.dpad = currDir;
            this.globalInsts = [];
            this.globalArgs = [];
            this.vm.deadSprites = [];
            this.vm.paintTile = [];
            this.vm.buttonMatch = [];
            this.vm.queued = [];
            this.vm.phase = RuleType.ButtonPress;
            this.vm.nextWorld.fill(0xf);

            this.allSprites(ts => {
                ts.x = ((ts.x >> 4) << 4) + 8;      // make sure sprite is centered
                ts.y = ((ts.y >> 4) << 4) + 8;      // on its tile
                ts.inst = -1;                       // reset instruction
                this.vm.queued.push(ts);
            });
        }

        processClosure(rc: RuleClosure) {
            this.evaluateRuleClosure(rc);
            if (this.p.getRuleType(rc.rid) == RuleType.ButtonPress) {
                if (this.vm.buttonMatch.indexOf(rc.self) == -1)
                    this.vm.buttonMatch.push(rc.self);
            }
        }

        continueRound() {
            if (this.vm.phase == RuleType.ButtonPress) {
                if (this.vm.queued.length > 0) {
                    let ts = this.vm.queued.pop();
                    return this.applyRules(RuleType.ButtonPress, this.ruleIndex[RuleType.ButtonPress], ts);
                } else {
                    this.vm.phase = RuleType.ContextChange;
                    this.allSprites(ts => { if (this.vm.buttonMatch.indexOf(ts) == -1) this.vm.queued.push(ts) });
                }
            }
            if (this.vm.phase == RuleType.ContextChange) {
                if (this.vm.queued.length > 0) {
                    let ts = this.vm.queued.pop();
                    if (ts.dir != Resting) {
                        // TODO: partition rules based on resting/moving
                        return this.applyRules(RuleType.ContextChange, this.ruleIndex[RuleType.ContextChange], ts);
                   } else if (this.restingWithChange(ts)) {
                        return this.applyRules(RuleType.ContextChange, this.ruleIndex[RuleType.ContextChange], ts);
                   }
                } else {
                    this.vm.phase = RuleType.Collision;
                }
            }
            if (this.vm.phase == RuleType.Collision) {
                if (this.vm.queued.length > 0) {
                    let ts = this.vm.queued.pop();                           
                    // now, look for collisions
                    // TODO: need a fix point around this, as new collisions may occur
                    // TODO: as moving sprites transition to resting sprites
                    // a collision can only take place between two sprites if one of
                    // them is going to move in the next round, against is initially
                    // all sprites and will dimish over time 
                    return this.collisionDetection( ts );
                } else {
                    this.vm.phase = -1;
                }
            }
            if (this.vm.phase == -1) {
                // finally, update the rules
                 this.updateWorld();
            }
            return null;
         }

        public allSprites(handler: (ts:TileSprite) => void) {
            this.vm.sprites.forEach(ls => { 
                if (ls) ls.forEach(ts => handler(ts));
            });
        }

        // optimization:
        // use the changed map to determine if a resting sprite
        // needs to have its resting rules applied. If no space
        // in the neighborhood around the tile changed in the last
        // round, then there is no need to apply the resting rules.
        private restingWithChange(ts: TileSprite) {
            let col = ts.col();
            let row = ts.row();
            // check neighborhood
            for(let i = -2; i <= 2; i++) {
                for (let j = -2; j <= 2; j++) {
                    if (Math.abs(i) + Math.abs(j) <= 2) {
                        let x = col + i;
                        let y = row + j;
                        if (this.inBounds(x,y) && this.vm.changed.getPixel(x,y))
                            return true;
                    }
                }
            }
            return false;
        }

        private ruleMatchesSprite(rid: number, ts: TileSprite) {
            return this.p.getSpriteKinds(rid).indexOf(ts.kind()) != -1;
        }

        // apply matching rules to tileSprite, based on the phase we are in
        private matchingRules(rules: number[], phase: RuleType, ts: TileSprite, handler: (rid: number) => void) {
            rules.forEach(rid => {
                if (this.ruleMatchesSprite(rid, ts) &&
                    (phase == RuleType.ContextChange && this.p.getDirFromRule(rid) == ts.dir
                  || phase == RuleType.ButtonPress && this.dpad.indexOf(this.p.getDirFromRule(rid)) != -1)) {
                    handler(rid);
                }
            });
        }

        private applyRules(phase: RuleType, rules: number[], ts: TileSprite) {
            let ruleClosures: RuleClosure[] = [];
            this.matchingRules(rules, phase, ts, (rid) => {
                let closure = this.evaluateRule(ts, rid);
                if (closure)
                    ruleClosures.push(closure);
            });
            if (phase != RuleType.ContextChange || ts.dir != Resting)
                return ruleClosures;
            // now deal with pesky resting rules that have precondition == true
            // this is need because of change optimization
            this.matchingRules(this.allTrueResting, phase, ts, (rid) => {
                let closure = this.evaluateRule(ts, rid);
                if (closure) {
                    ruleClosures.push(closure);
                }
            });
            return ruleClosures;
        }

        // precondition: moving(ts)
        private collidingRules(ts: TileSprite, handler: (rid: number) => void) {
            this.ruleIndex[RuleType.Collision].forEach(rid => {
                if (this.ruleMatchesSprite(rid, ts) && this.p.getDirFromRule(rid) == ts.arg) {
                    handler(rid);
                }
            });
        }

        // a tile sprite will move if it has been issued an appropriate move command
        private moving(ts: TileSprite) {
            return ts.inst == CommandType.Move && ts.arg < MoveArg.Stop;
        }

        // for each sprite ts that is will move (into T):
        // - look for colliding sprite os != ts, as defined
        //   (a) os in square T, resting or moving towards ts, or
        //   (b) os moving into T
        private collisionDetection(ts: TileSprite) {
            let rcs: RuleClosure[] = [];
            if (!this.moving(ts)) return rcs;
            let wcol = ts.col() + moveXdelta(ts.arg);
            let wrow = ts.row() + moveYdelta(ts.arg);
            this.collidingRules(ts, (rid) => {
                // T = (wcol, wrow)
                let moving = !this.p.isCollidingResting(rid);
                // TODO: moving is a predicate on the sprite direction of the other sprite
                this.allSprites(os => {
                    if (os == ts) return;
                    // (a) os in square T, resting or moving towards ts, or
                    if (os.col() == wcol && os.row() == wrow) {
                        if (!moving && !this.moving(os) || 
                                moving && this.moving(os) && oppDir(ts.arg,os.arg)) {
                            this.collide(rid, ts, os, rcs);
                            return;
                        }
                    } else if (moving && this.moving(os)) {
                        let leftRotate = flipRotateDir(ts.arg, FlipRotate.Left);
                        let osCol = wcol + moveXdelta(leftRotate);
                        let osRow = wrow + moveYdelta(leftRotate);
                        if (os.col() == osCol && os.row() == osRow && oppDir(leftRotate,os.arg)) {
                            this.collide(rid, ts, os, rcs);
                            return;
                        } 
                        let rightRotate = flipRotateDir(ts.arg, FlipRotate.Right);
                        osCol = wcol + moveXdelta(rightRotate);
                        osRow = wrow + moveYdelta(rightRotate);
                        if (os.col() == osCol && os.row() == osRow && oppDir(rightRotate, os.arg)) {
                            this.collide(rid, ts, os, rcs);
                            return;
                        }
                        osCol = wcol + moveXdelta(ts.arg);
                        osRow = wrow + moveYdelta(ts.arg);
                        if (os.col() == osCol && os.row() == osRow && oppDir(ts.arg, os.arg)) {
                            this.collide(rid, ts, os, rcs);
                            return;
                        }
                    }
                });
            });
            return rcs;
        }

        private collide(rid: number, ts: TileSprite, os: TileSprite, rcs: RuleClosure[]) {
            let wcol = ts.col() + moveXdelta(ts.arg);
            let wrow = ts.row() + moveYdelta(ts.arg);
            // we already have the witness
            let witnesses: TileSprite[] = [ os ];
            if (this.evaluateWhenDo(ts, rid, 2+moveXdelta(ts.arg), 2+moveYdelta(ts.arg), witnesses)) {
                rcs.push(new RuleClosure(rid, ts, witnesses));
            }
        }

        // ---------------------------------------------------------------------

        private updateWorld() {
            this.vm.changed.fill(0);
            // update the state of each sprite, based on instructions
            this.allSprites(ts => {
                ts.update();
                if (ts.dir != -1) {
                    // if sprite is moving then dirty its current
                    // location and next location
                    this.vm.changed.setPixel(ts.col(), ts.row(), 1);
                    this.vm.changed.setPixel(ts.col() + moveXdelta(ts.dir),
                        ts.row() + moveYdelta(ts.dir), 1);
                }
            });
            // update the tile map and set dirty bits in changed map
            if (this.vm.paintTile != null) {
                // fast path
                this.vm.paintTile.forEach(pt => {
                    const tm = game.currentScene().tileMap;
                    tm.setTileAt(pt.col, pt.row, pt.tile);
                    this.vm.changed.setPixel(pt.col, pt.row, 1);
                });
            } else {
                // general backup
                for (let x = 0; x < this.vm.nextWorld.width; x++) {
                    for (let y = 0; y < this.vm.nextWorld.height; y++) {
                        let pixel = this.vm.nextWorld.getPixel(x, y);
                        if (pixel != 0xf) {
                            //this.vm.world.setPixel(x, y, pixel);
                            const tm = game.currentScene().tileMap;
                            tm.setTileAt(x, y, pixel);
                            this.vm.changed.setPixel(x, y, 1);
                        }
                    }
                }
            }
            // now, execute the global instructions
            for (let i = 0; i < this.globalInsts.length; i++) {
                let inst = this.globalInsts[i];
                let arg = this.globalArgs[i];
                switch (inst) {
                    case CommandType.Game: {
                        if (arg == GameArg.Win || arg == GameArg.Lose) {
                            this.vm.game = arg == GameArg.Win ? GameState.Won : GameState.Lost;
                        }
                        break;
                    }
                }
            }
        }

        // ---------------------------------------------------------------------

        // store the sprite witnesses identified by guards
        private evaluateRule(ts: TileSprite, rid: number) {
            let witnesses: TileSprite[] = [];
            for(let col = 0; col < 5; col++) {
                for (let row = 0; row < 5; row++) {
                    if (Math.abs(2-col) + Math.abs(2-row) > 2)
                        continue;
                    if (!this.evaluateWhenDo(ts, rid, col, row, witnesses))
                        return null;
                }
            }
            // all the whendos passed and we've collected witnesses (other sprites)
            // so, we will execute the rule on the self sprite ts
            return new RuleClosure(rid, ts, witnesses);
        }

        private getWitness(kind: number, col: number, row: number, self: TileSprite) {
            return this.vm.sprites[kind] && this.vm.sprites[kind].find(ts => ts != self && ts.col() == col && ts.row() == row);
        }

        private inBounds(col: number, row: number) {
            return 0 <= col && col < this.vm.nextWorld.width &&
                   0 <= row && row < this.vm.nextWorld.height;
        }

        // Include and OneOf are equivalent now
        private evaluateWhenDo(ts: TileSprite, rid: number, 
                col: number, row: number, witnesses: TileSprite[]) {
            let whendo = this.p.getWhenDo(rid, col, row);
            if (whendo == -1 || this.p.whendoTrue(rid, whendo))
                return true;
            let self = col == 2 && row == 2; 
            let wcol = ts.col() + (col - 2);
            let wrow = ts.row() + (row - 2);
            if (!this.inBounds(wcol, wrow))
                return false;
            let oneOf: boolean = false;
            let oneOfPassed: boolean = false;
            let captureWitness: TileSprite = null;
            for(let kind = 0; kind < this.p.backCnt(); kind++) {
                const tm = game.currentScene().tileMap;
                let hasKind = tm.getTile(wcol, wrow).tileSet == kind;
                let attr = this.p.getSetBgAttr(rid, whendo, kind);
                if (attr == AttrType.Exclude && hasKind) {
                    return false;
                } else if (attr == AttrType.Include) {
                    oneOf = true;
                    if (hasKind) oneOfPassed = true;
                }
            }
            let adjacent = Math.abs(2 - col) + Math.abs(2 - row) <= 1;
            for(let kind = 0; kind < this.p.spriteCnt(); kind++) {
                let attr = this.p.getSetSpAttr(rid, whendo, kind);
                let witness = this.getWitness(kind, wcol, wrow, self ? ts : null);
                // special case for collisions
                if (this.p.getRuleType(rid) == RuleType.Collision) {
                    witness = witnesses[0].kind() == kind ? witnesses[0] : null;
                }
                if (attr == AttrType.Exclude && witness) {
                    return false;
                } else if (attr == AttrType.Include) {
                    oneOf = true;
                    if (witness) oneOfPassed = true;
                    if (adjacent && !captureWitness)
                        captureWitness = witness;
                }
            }
            // collision case: if we made it through here then 
            // we have witness and oneOf is false, as expected
            let ret = !oneOf || oneOfPassed;
            if (ret && captureWitness && this.p.getRuleType(rid) != RuleType.Collision) {
                witnesses.push(captureWitness);
            }
            return ret;
        }
    
        private evaluateRuleClosure(rc: RuleClosure) {
            for (let col = 0; col < 5; col++) {
                for (let row = 0; row < 5; row++) {
                    if (Math.abs(2 - col) + Math.abs(2 - row) > 2)
                        continue;
                    this.evaluateWhenDoCommands(rc, col, row);
                }
            }
        }

        private evaluateWhenDoCommands(rc: RuleClosure, col: number, row: number) {
            let wid = this.p.getWhenDo(rc.rid, col, row);
            if (wid == -1 || this.p.getCmdInst(rc.rid, wid, 0) == -1)
                return;
            let wcol = rc.self.col() + (col - 2);
            let wrow = rc.self.row() + (row - 2);
            let self = col == 2 && row == 2;
            for (let cid = 0; cid < 4; cid++) {
                let inst = this.p.getCmdInst(rc.rid, wid, cid);
                if (inst == -1) break;
                let arg = this.p.getCmdArg(rc.rid, wid, cid);
                switch(inst) {
                    case CommandType.Paint: {
                        if (this.vm.nextWorld.getPixel(wcol, wrow) == 0xf) {
                            this.vm.nextWorld.setPixel(wcol, wrow, arg);
                            if (this.vm.paintTile && this.vm.paintTile.length < 5) {
                                this.vm.paintTile.push(new PaintTile(wcol, wrow, arg));
                            } else 
                                this.vm.paintTile = null;
                        }
                        break;
                    }
                    case CommandType.Move: {
                        let colliding = this.p.getRuleType(rc.rid) == RuleType.Collision;
                        let button = this.p.getRuleType(rc.rid) == RuleType.ButtonPress;
                        let witness = self ? rc.self : 
                                (colliding ? rc.witnesses[0]
                                    : rc.witnesses.find(ts => ts.col() == wcol && ts.row() == wrow));
                        if (witness && (witness.inst == -1 || Math.randomRange(0,1) < 0.5 || colliding || button)) {
                            witness.inst = inst;
                            witness.arg = arg;
                        }
                        break;
                    }
                    case CommandType.Sprite: {
                        // the witness is found where expected
                        let witness = rc.witnesses.find(ts => ts.col() == wcol && ts.row() == wrow);
                        // except in the case of collisions with moving sprites
                        if (this.p.getRuleType(rc.rid) == RuleType.Collision) {
                            // TODO: moving against moving only here...
                            witness = rc.witnesses[0];
                        }
                        if (arg == SpriteArg.Remove && witness) {
                            witness.state = SpriteState.Dead;
                            this.vm.deadSprites.push(witness);
                        }
                        break;
                    }
                    case CommandType.Game: {
                        // all game commands are global
                        this.globalInsts.push(inst);
                        this.globalArgs.push(arg);
                        break;
                    }
                }
            }
        }
    }

    export class RunGame extends BackgroundBase {
        private running: boolean;
        private vm: TileWorldVM;
        private signal: TileSprite;
        private state: VMState;
        constructor(private p: Project, rules: number[], private debug: boolean = false) {
            super();
            this.vm = new TileWorldVM(p, rules);
        }
        
        public setWorld(w: Image, sprites: Image) {
            this.signal = null;
            this.state = new VMState();
            this.state.game = GameState.InPlay;
            this.state.sprites = [];
            const currScene = game.currentScene();
            currScene.tileMap = new tiles.legacy.LegacyTilemap(TileScale.Sixteen, this.debug ? 2 : 0);
            scene.setTileMap(w.clone());
            this.state.nextWorld = w.clone();
            this.state.changed = w.clone();

            // initialize fixed and movable sprites
            for (let kind = 0; kind < this.p.all().length; kind++) {
                if (kind < this.p.fixed().length) {
                    let art = this.p.getImage(kind);
                    scene.setTile(kind, art);
                } else {
                    this.state.sprites[kind] = [];
                }
            }
        
            for(let x = 0; x<sprites.width; x++) {
                for (let y = 0; y < sprites.height; y++) {
                    let kind = sprites.getPixel(x,y);
                    if (kind == 0xf) continue;
                    let art = this.p.getImage(kind);
                    let ts = new TileSprite(art, kind, this.debug);
                    this.state.sprites[kind].push(ts);
                    ts.x = (x << 4) + 8;
                    ts.y = (y << 4) + 8;
                }   
            }
        }

        private roundToCompletion(dirs: number[]) {
            this.vm.startRound(dirs);
            while (this.state.phase != Phase.Completed) {
                let rcs = this.vm.continueRound();
                while (rcs && rcs.length > 0) {
                    let rc = rcs.pop();
                    this.vm.processClosure(rc);
                }
            }
            this.vm.continueRound();
        }

        private currentDirection: MoveDirection[];
        public start() {
            this.currentDirection = [];
            let signal = new TileSprite(cursorIn, 0);
            signal.setFlag(SpriteFlag.Invisible, true);
            signal.x = signal.y = 8;
            signal.dir = MoveDirection.Right;
            signal.inst = -1;
            this.signal = signal;
            let halfway = false;

            // get the game started
 
            let playerId = this.p.getPlayer();
            if (playerId != -1 && this.state.sprites[playerId]) {
                scene.cameraFollowSprite(this.state.sprites[playerId][0]);
            }

            this.vm.setState(this.state);
            this.roundToCompletion([]);
            this.running = true;

            game.onUpdate(() => {
                if (!this.running)
                    return;
                // has signal sprite moved to new tile
                // then do a worldUpdate and reset the signal sprite
                if (this.signal.x >= 23) {
                    if (this.state.game != GameState.InPlay) {
                        this.running = false;
                        let win = this.state.game == GameState.Won;
                        pause(400);
                        game.showDialog("Game Over", " you " + (win ? "won" : "lost"));
                        game.waitAnyButton();
                        return;
                    } 
                    this.signal.x = 8;
                    this.roundToCompletion(this.currentDirection);
                    halfway = false;
                    this.currentDirection = [];
                } else if (!halfway && this.signal.x >= 16) {
                    if (this.state.game == GameState.InPlay) {
                        this.state.deadSprites.forEach(ts => {
                            this.state.sprites[ts.kind()].removeElement(ts);
                            ts.destroy();
                        });
                    }
                    halfway = true;
                }
            });

            game.onPaint(() => {
                // debugger here
                if (this.debug) {
                    screen.drawImage(debug, 0, 0)
                }
            });

            this.registerController();
            signal.vx = 100;
        }

        private debuggerUI() {
            // play
            // step
        }

        private registerController() {
            controller.setRepeatDefault(200, 80);
            controller.left.onEvent(ControllerButtonEvent.Pressed, () => {
                this.requestMove(MoveDirection.Left)
            })
            controller.left.onEvent(ControllerButtonEvent.Repeated, () => {
                this.requestMove(MoveDirection.Left)
            })
            controller.right.onEvent(ControllerButtonEvent.Pressed, () => {
                this.requestMove(MoveDirection.Right)
            })
            controller.right.onEvent(ControllerButtonEvent.Repeated, () => {
                this.requestMove(MoveDirection.Right)
            })
            controller.up.onEvent(ControllerButtonEvent.Pressed, () => {
                this.requestMove(MoveDirection.Up)
            })
            controller.up.onEvent(ControllerButtonEvent.Repeated, () => {
                this.requestMove(MoveDirection.Up)
            })
            controller.down.onEvent(ControllerButtonEvent.Pressed, () => {
                this.requestMove(MoveDirection.Down)
            })
            controller.down.onEvent(ControllerButtonEvent.Repeated, () => {
                this.requestMove(MoveDirection.Down)
            })
            controller.A.onEvent(ControllerButtonEvent.Pressed, () => {
                this.requestMove(MoveDirection.Down);
            });
            controller.A.onEvent(ControllerButtonEvent.Pressed, () => {
                this.requestMove(PushingArg.AButton);
            });
            controller.A.onEvent(ControllerButtonEvent.Repeated, () => {
                this.requestMove(PushingArg.AButton);
            });
            controller.B.onEvent(ControllerButtonEvent.Pressed, () => {
                // TODO: debugger
                controller.setRepeatDefault(500, 80);
                game.popScene();
            })
        }

        private requestMove(dir: number) {
            // TODO: debuggger
            if (!this.running) {
                controller.setRepeatDefault(500, 80);
                game.popScene();
            } else if (this.currentDirection.indexOf(dir) == -1)
                this.currentDirection.push(dir);
        }
    }
}
