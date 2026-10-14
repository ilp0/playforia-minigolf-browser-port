export interface ReplayAdapter {
    control(text:string):string;
    active():boolean;
    id():string;
    frame(value:unknown):void;
    command(packet:string,local?:boolean):void;
}
declare global {interface Window {aapeliReplay?:ReplayAdapter;aapeliReplayEngine?:{kind:string;build:string};aapeliClientPlayback?:{next():string|null;ready():void;now():number;speed():number;asset(path:string):string;busy?():boolean;};}}
export {};
