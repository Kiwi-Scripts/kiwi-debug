import { ADAPTER_CONTRACT, defineAdapter, type Member, type Section } from '@kiwi-js/debug/adapter';

import { currentTask, onRender, onWrite, ReactiveBase, scheduleRender, UNIT_ATTR, unitsOn, type PlaygroundUnit } from './mini';

/** The elements above `el`, nearest first. */
function* ancestors( el: Element ): Generator<Element> {
    for ( let at = el.parentElement; at; at = at.parentElement ) {
        yield at;
    }
}

const isUnit = ( value: unknown ): value is PlaygroundUnit => typeof value === 'object' && value !== null && 'instance' in value;

/**
 * The adapter for the playground's mini framework. A unit is an object attached to an element under an identifier
 * (`data-unit="Counter"`); its members are the own properties of the instance, sorted into inputs, outputs and the rest.
 */
export const playgroundAdapter = defineAdapter( {
    meta: { contract: ADAPTER_CONTRACT, id: 'playground', name: 'Playground', version: '1' },

    env: {
        isDev: () => true,
        onRender: cb => onRender( cb ),
        flush: () => scheduleRender(),
        taskSource: () => currentTask,
        internalFrames: /\/playground\/src\/mini\.ts/
    },

    units: {
        at: el => unitsOn( el ),

        describe: unit => {
            const u = unit as PlaygroundUnit;
            return { name: u.name, kind: u.kind, element: u.element };
        },

        members: unit => {
            const u = unit as PlaygroundUnit;
            return Object.keys( u.instance ).filter( key => !key.startsWith( '_' ) ).map( ( name ): Member => ( {
                group: u.inputs.includes( name ) ? 'inputs' : u.outputs.includes( name ) ? 'outputs' : 'properties',
                name,
                read: () => ( u.instance as Record<string, unknown> )[name]
            } ) );
        },

        // Expressions may start anywhere on the instance, including what is not a member (`_cache`, getters).
        instance: unit => ( unit as PlaygroundUnit ).instance,

        owner: el => {
            for ( const parent of ancestors( el ) ) {
                const component = unitsOn( parent ).find( u => u.kind === 'component' );
                if ( component ) {
                    return component;
                }
            }
            return undefined;
        },

        sections: el => {
            const units = unitsOn( el );
            const sections: Section[] = [{ id: 'injector', label: 'injector', read: () => ( { element: el, units: units.map( u => u.name ) } ) }];
            const providers = units.flatMap( u => u.providers.map( p => ( { ...p, owner: p.owner ?? u.name } ) ) );
            if ( providers.length ) {
                sections.push( { id: 'providers', label: 'providers', read: () => providers, list: () => providers } );
            }
            return sections;
        }
    },

    reactivity: {
        nodeOf: value => value instanceof ReactiveBase ? value : undefined,
        renderNodeOf: el => unitsOn( el ).find( u => u.template )?.template,
        onWrite: cb => onWrite( cb )
    },

    addressing: {
        // The position among all elements that carry the identifier: stable across reloads of the same page.
        of: ( unit, el ) => {
            const { name } = unit as PlaygroundUnit;
            return `${name}#${Array.from( document.querySelectorAll( `[${UNIT_ATTR}~="${name}"]` ) ).indexOf( el )}`;
        },
        resolve: address => {
            const [name, index] = address.split( '#' );
            const el = document.querySelectorAll( `[${UNIT_ATTR}~="${name}"]` )[Number( index )];
            const unit = el && unitsOn( el ).find( u => u.name === name );
            return unit && isUnit( unit ) ? { unit, element: el } : undefined;
        }
    }
} );
